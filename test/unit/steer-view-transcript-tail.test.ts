import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createTranscriptTail, readTranscriptFallback, trustedRootsForTarget } from "../../src/tui/steer-view/transcript-tail.ts";
import type { SteerViewTarget } from "../../src/tui/steer-view/target-model.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function tempFile(): { root: string; file: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "steer-tail-"));
	roots.push(root);
	return { root, file: path.join(root, "transcript.jsonl") };
}

describe("steer transcript tail", () => {
	it("buffers partial lines and advances by byte offset", () => {
		const { root, file } = tempFile();
		fs.writeFileSync(file, '{"recordType":"message","ts":1,"role":"user","text":"he');
		const tail = createTranscriptTail(file, { trustedRoots: [root] });
		assert.deepEqual(tail.poll().records, []);
		fs.appendFileSync(file, 'llo"}\n{"recordType":"tool_start","ts":2,"toolName":"read"}\n');
		assert.deepEqual(tail.poll().records.map((record) => record.recordType), ["message", "tool_start"]);
		assert.deepEqual(tail.poll().records, []);
	});

	it("resets on truncate and replacement and tolerates truncated markers", () => {
		const { root, file } = tempFile();
		fs.writeFileSync(file, '{"recordType":"message","ts":1,"role":"assistant","text":"old"}\n');
		const tail = createTranscriptTail(file, { trustedRoots: [root] });
		assert.equal(tail.poll().reset, false);
		fs.writeFileSync(file, '{"recordType":"truncated","ts":2,"message":"limit"}\n');
		const truncated = tail.poll();
		assert.equal(truncated.reset, true);
		assert.equal(truncated.records[0]?.recordType, "truncated");
		const replacement = path.join(root, "replacement");
		fs.writeFileSync(replacement, '{"recordType":"message","ts":3,"role":"user","text":"new"}\n');
		fs.renameSync(replacement, file);
		assert.equal(tail.poll().reset, true);
	});

	it("detects an in-place rewrite that grows without changing the inode", () => {
		const { root, file } = tempFile();
		fs.writeFileSync(file, '{"recordType":"message","ts":1,"role":"user","text":"old"}\n');
		const tail = createTranscriptTail(file, { trustedRoots: [root] });
		tail.poll();
		fs.writeFileSync(file, '{"recordType":"message","ts":2,"role":"assistant","text":"a much longer replacement"}\n');
		const update = tail.poll();
		assert.equal(update.reset, true);
		assert.equal(update.records[0]?.text, "a much longer replacement");
	});

	it("rejects paths outside trusted roots", () => {
		const first = tempFile();
		const second = tempFile();
		fs.writeFileSync(second.file, "{}\n");
		const poll = createTranscriptTail(second.file, { trustedRoots: [first.root] }).poll();
		assert.match(poll.warnings[0]!, /outside trusted roots/);
	});

	it("does not trust a transcript or session parent directory supplied by target metadata", () => {
		const trusted = tempFile();
		const untrusted = tempFile();
		fs.writeFileSync(untrusted.file, "{}\n");
		const target: SteerViewTarget = {
			key: "async:r:0", kind: "async", runId: "r", index: 0, agent: "a",
			status: "running", active: true, updatedAt: 1, asyncDir: trusted.root,
			transcriptPath: untrusted.file, sessionFile: untrusted.file,
		};
		const poll = createTranscriptTail(untrusted.file, { trustedRoots: trustedRootsForTarget(target) }).poll();
		assert.match(poll.warnings[0]!, /outside trusted roots/);
	});

	it("falls back through output, recent output, and session", () => {
		const { root, file } = tempFile();
		fs.writeFileSync(file, "one\ntwo\n");
		const base: SteerViewTarget = { key: "async:r:0", kind: "async", runId: "r", index: 0, agent: "a", status: "running", active: true, updatedAt: 1, asyncDir: root };
		assert.deepEqual(readTranscriptFallback({ ...base, outputFile: file }).records.map((record) => record.text), ["one", "two"]);
		assert.equal(readTranscriptFallback({ ...base, recentOutput: "recent" }).records[0]?.text, "recent");
		fs.writeFileSync(file, `${JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "session" }] } })}\n`);
		assert.equal(readTranscriptFallback({ ...base, sessionFile: file }).records[0]?.text, "assistant: session");
	});
});
