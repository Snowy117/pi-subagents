import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { conversationDir, heartbeatFilePath, relayFilePath, requestsFilePath, resolveConversationStepKey } from "../../src/runs/background/runner/conversation-bridge.ts";
import { closeAllOpenAsyncBridgeChannels, createAsyncBridgeChannel, relayHasTerminalMarker } from "../../src/tui/steer-view/async-bridge-channel.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("async bridge channel (parent side)", () => {
	let tempDir: string;
	let asyncDir: string;
	let stepKey: string;
	let dir: string;
	let relayFile: string;
	let requestsFile: string;
	let heartbeatFile: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-channel-"));
		asyncDir = path.join(tempDir, "run-1");
		fs.mkdirSync(asyncDir, { recursive: true });
		stepKey = resolveConversationStepKey(0, "worker");
		dir = conversationDir(asyncDir);
		fs.mkdirSync(dir, { recursive: true });
		relayFile = relayFilePath(dir, stepKey);
		requestsFile = requestsFilePath(dir, stepKey);
		heartbeatFile = heartbeatFilePath(dir, stepKey);
	});

	afterEach(() => {
		closeAllOpenAsyncBridgeChannels();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const open = (options: Parameters<typeof createAsyncBridgeChannel>[2] = {}): ReturnType<typeof createAsyncBridgeChannel> =>
		createAsyncBridgeChannel(asyncDir, stepKey, { pollMs: 10, heartbeatIntervalMs: 20, ...options });
	const appendRelay = (line: unknown): void => fs.appendFileSync(relayFile, `${JSON.stringify(line)}\n`, "utf-8");
	const relayText = (): string => fs.existsSync(relayFile) ? fs.readFileSync(relayFile, "utf-8") : "";
	const heartbeatText = (): string => fs.existsSync(heartbeatFile) ? fs.readFileSync(heartbeatFile, "utf-8") : "{}";

	it("writes a heartbeat on creation, refreshes it on the interval, and clears it on close", async () => {
		const channel = open();
		await sleep(10);
		assert.ok(fs.existsSync(heartbeatFile), "heartbeat must exist right after creation");
		assert.equal(Number.isFinite((JSON.parse(heartbeatText()) as { ts?: unknown }).ts), true);
		await sleep(45);
		await channel.close("graceful");
		assert.equal(fs.existsSync(heartbeatFile), false, "close must delete the heartbeat so the runner can exit");
		const closed = await Promise.race([
			channel.closed.then(() => true),
			sleep(50).then(() => false),
		]);
		assert.equal(closed, true, "close must resolve the closed promise");
	});

	it("endConversation stops the heartbeat without touching the child (parent-side only)", async () => {
		const channel = open();
		await sleep(10);
		assert.ok(fs.existsSync(heartbeatFile));
		channel.endConversation();
		assert.equal(fs.existsSync(heartbeatFile), false, "endConversation must stop the heartbeat");
	});

	it("appends prompts to requests.jsonl, stamping id and ts without overwriting caller ids", async () => {
		const channel = open();
		const idWithout = channel.write({ type: "prompt", message: "hello" });
		assert.ok(idWithout, "write must return the assigned id");
		const idWithParam = channel.write({ type: "prompt", message: "again" }, "fixed-id");
		assert.equal(idWithParam, "fixed-id");
		const idInRecord = channel.write({ type: "prompt", message: "third", id: "record-id" });
		assert.equal(idInRecord, "record-id", "a record-provided id must never be overwritten");

		const lines = fs.readFileSync(requestsFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { id?: string; ts?: unknown; message?: string });
		assert.equal(lines.length, 3);
		assert.equal(lines[0]!.id, idWithout);
		assert.equal(typeof lines[0]!.ts, "number");
		assert.equal(lines[1]!.id, "fixed-id");
		assert.equal(lines[2]!.id, "record-id");
		assert.deepEqual(lines.filter((line) => line.message === "third"), [lines[2]!]);
	});

	it("forwards ordinary relay lines verbatim and consumes synthetic markers", async () => {
		const channel = open();
		const received: string[] = [];
		channel.onStdoutLine((line) => received.push(line));
		appendRelay({ type: "child_ready", key: "run-1/0" });
		appendRelay({ type: "response", id: "x", command: "get_commands", success: true, data: { commands: [{ name: "dcp" }] } });
		await sleep(30);
		assert.deepEqual(received.map((line) => JSON.parse(line) as { type?: string }).map((record) => record.type), ["response"]);
		assert.equal(channel.settled, false, "child_ready must not mark settled");
	});

	it("marks settled on child_settled and resolves closed on child_closed / child_unavailable", async () => {
		const channel = open();
		const received: string[] = [];
		channel.onStdoutLine((line) => received.push(line));
		appendRelay({ type: "child_settled", key: "run-1/0" });
		await sleep(20);
		assert.equal(channel.settled, true, "child_settled marker must flip settled");
		appendRelay({ type: "child_closed", key: "run-1/0", reason: "exit:0" });
		const closed = await Promise.race([channel.closed.then(() => true), sleep(100).then(() => false)]);
		assert.equal(closed, true, "child_closed must resolve closed");
		assert.equal(received.length, 0, "markers must never reach subscribers");
	});

	it("resolves closed on child_unavailable (request arrived with no resident)", async () => {
		const channel = open();
		appendRelay({ type: "child_unavailable", key: "run-1/0", reason: "no-resident" });
		const closed = await Promise.race([channel.closed.then(() => true), sleep(100).then(() => false)]);
		assert.equal(closed, true);
	});

	it("only delivers lines appended after creation (history is seeded from the transcript)", async () => {
		appendRelay({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "pre-open history" }] } });
		const channel = open();
		const received: string[] = [];
		channel.onStdoutLine((line) => received.push(line));
		await sleep(20);
		assert.equal(received.length, 0, "pre-existing relay content must not re-render");
		appendRelay({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "live line" }] } });
		await sleep(20);
		assert.equal(received.length, 1, "post-creation lines are delivered");
	});

	it("resyncs after a relay truncation without re-delivering the preserved tail", async () => {
		const channel = open();
		const received: string[] = [];
		channel.onStdoutLine((line) => received.push(line));
		appendRelay({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "A" }] } });
		// A long record that pushes the relay well past the cursor, so the
		// rewritten (truncated) file lands below the fed offset.
		appendRelay({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "P".repeat(50_000) }] } });
		await sleep(20);
		assert.equal(received.length, 2);
		// Simulate the runner truncating at the relay cap: rewrite the file with
		// the relay_reset marker + the preserved recent tail (already delivered).
		const preserved = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "A" }] } });
		fs.writeFileSync(relayFile, `${JSON.stringify({ type: "relay_reset", key: stepKey, stepKey })}\n${preserved}\n`, "utf-8");
		await sleep(20);
		assert.equal(received.length, 2, "the preserved tail must not be re-delivered after a reset");
		appendRelay({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "C" }] } });
		await sleep(20);
		assert.equal(received.length, 3, "lines appended after the truncation are delivered");
	});

	it("resolves closed via staleness when the runner pid dies and no relay data arrives", async () => {
		// lastRelayAt = creation; staleCloseMs=50; kill always false → closed soon.
		const channel = open({ runnerPid: 42, staleCloseMs: 50, kill: () => false });
		const closed = await Promise.race([channel.closed.then(() => true), sleep(400).then(() => false)]);
		assert.equal(closed, true, "a dead runner with no relay traffic must close the channel");
	});

	it("stays open while the runner pid is alive even with no relay traffic", async () => {
		const channel = open({ runnerPid: 42, staleCloseMs: 30, kill: () => true });
		const closed = await Promise.race([channel.closed.then(() => true), sleep(120).then(() => false)]);
		assert.equal(closed, false, "a live runner keeps the channel open");
		await channel.close("force");
	});

	it("relay activity keeps a dead-pid channel open (marker or line counts)", async () => {
		const channel = open({ runnerPid: 42, staleCloseMs: 30, kill: () => false });
		// Keep appending content faster than the staleness window.
		const timer = setInterval(() => appendRelay({ type: "pong", key: "run-1/0", requestId: `p-${Date.now()}` }), 10);
		try {
			const closed = await Promise.race([channel.closed.then(() => true), sleep(150).then(() => false)]);
			assert.equal(closed, false, "relay traffic must postpone the staleness close");
		} finally {
			clearInterval(timer);
			await channel.close("force");
		}
	});

	it("delivers to every subscriber and unsubscribes cleanly", async () => {
		const channel = open();
		const first: string[] = [];
		const second: string[] = [];
		const unsubscribe = channel.onStdoutLine((line) => first.push(line));
		channel.onStdoutLine((line) => second.push(line));
		appendRelay({ type: "response", id: "a", command: "get_state", success: true, data: {} });
		await sleep(20);
		assert.equal(first.length, 1);
		assert.equal(second.length, 1);
		unsubscribe();
		appendRelay({ type: "response", id: "b", command: "get_state", success: true, data: {} });
		await sleep(20);
		assert.equal(first.length, 1, "unsubscribed handler must not receive more lines");
		assert.equal(second.length, 2);
		await channel.close("force");
	});

	it("relayHasTerminalMarker detects child_closed/child_unavailable in the relay", () => {
		assert.equal(relayHasTerminalMarker(asyncDir, stepKey, fs), false, "no relay → no terminal marker");
		appendRelay({ type: "child_ready", key: "run-1/0" });
		assert.equal(relayHasTerminalMarker(asyncDir, stepKey, fs), false);
		appendRelay({ type: "child_closed", key: "run-1/0", reason: "exit:0" });
		assert.equal(relayHasTerminalMarker(asyncDir, stepKey, fs), true);
	});

	it("touch refreshes the heartbeat immediately", async () => {
		const channel = open({ heartbeatIntervalMs: 60_000 });
		await sleep(10);
		const before = (JSON.parse(heartbeatText()) as { ts: number }).ts;
		await sleep(20);
		channel.touch();
		const after = (JSON.parse(heartbeatText()) as { ts: number }).ts;
		assert.ok(after >= before, "touch must write a fresh heartbeat");
		await channel.close("graceful");
	});
});