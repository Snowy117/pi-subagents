import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	cleanupLiveTranscripts,
	isRuntimeLiveTranscript,
	liveTranscriptPath,
	markLiveTranscriptTerminal,
	resolveLiveTranscriptPath,
	retainLiveTranscript,
} from "../../src/shared/live-transcript.ts";

describe("live transcript lifecycle", () => {
	afterEach(() => cleanupLiveTranscripts());

	it("reuses a persistent artifact path and scopes artifact-off paths", () => {
		assert.equal(resolveLiveTranscriptPath({ persistentPath: "/artifacts/run.jsonl", runId: "run-a", index: 2 }), "/artifacts/run.jsonl");
		const runtimePath = resolveLiveTranscriptPath({ runId: "run-a", index: 2 });
		assert.equal(runtimePath, liveTranscriptPath("run-a", 2));
		assert.equal(isRuntimeLiveTranscript(runtimePath), true);
	});

	it("keeps a terminal transcript until its view lease releases", () => {
		const transcriptPath = liveTranscriptPath(`lease-${Date.now()}`, 0);
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
		fs.writeFileSync(transcriptPath, "line\n");
		const release = retainLiveTranscript(transcriptPath, { id: () => "view" });
		markLiveTranscriptTerminal(transcriptPath);
		assert.equal(fs.existsSync(transcriptPath), true);
		release();
		assert.equal(fs.existsSync(transcriptPath), false);
	});

	it("does not delete persistent artifacts on terminal or release", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-transcript-artifact-"));
		const transcriptPath = path.join(root, "artifact.jsonl");
		fs.writeFileSync(transcriptPath, "line\n");
		const release = retainLiveTranscript(transcriptPath);
		markLiveTranscriptTerminal(transcriptPath);
		release();
		assert.equal(fs.existsSync(transcriptPath), true);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("does not delete a terminal transcript when its lease directory is unreadable", () => {
		const transcriptPath = liveTranscriptPath("unreadable-leases", 0);
		const removed: string[] = [];
		markLiveTranscriptTerminal(transcriptPath, { fs: {
			existsSync: () => true,
			mkdirSync: () => undefined,
			readdirSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
			rmSync: (candidate) => { removed.push(String(candidate)); },
			writeFileSync: () => undefined,
		} });
		assert.deepEqual(removed, []);
	});
});
