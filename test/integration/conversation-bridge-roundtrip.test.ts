import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createMockPi, createTempDir, events, makeAgent, removeTempDir } from "../support/helpers.ts";
import {
	available,
	ASYNC_DIR,
	executeAsyncSingle,
	waitForAsyncResultFile,
} from "../support/async-execution-harness.ts";
import {
	conversationDir,
	heartbeatFilePath,
	relayFilePath,
	requestsFilePath,
	resolveConversationStepKey,
} from "../../src/runs/background/runner/conversation-bridge.ts";
import { createAsyncBridgeChannel } from "../../src/tui/steer-view/async-bridge-channel.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 20_000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

function readRelayIfExists(file: string): string {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return "";
	}
}

describe("async conversation bridge round-trip", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("relays child stdout, forwards follow-up requests to the child, answers pings, and lingers until the conversation ends", async () => {
		mockPi.onCall({ jsonl: [events.assistantMessage("bridge first reply")] });
		const id = `bridge-rtt-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const stepKey = resolveConversationStepKey(0, "worker");
		const relayFile = relayFilePath(conversationDir(asyncDir), stepKey);
		const requestsFile = requestsFilePath(conversationDir(asyncDir), stepKey);
		const heartbeatFile = heartbeatFilePath(conversationDir(asyncDir), stepKey);

		// The conversation may be opened before the runner even starts (a queued
		// target): pre-create the bridge dir and pre-write the heartbeat so the
		// runner sees a fresh heartbeat at its linger check right after finalize.
		fs.mkdirSync(conversationDir(asyncDir), { recursive: true });
		let heartbeatCleared = false;
		const writeHeartbeat = () => {
			if (heartbeatCleared) return;
			fs.writeFileSync(heartbeatFile, JSON.stringify({ ts: Date.now() }), "utf-8");
		};
		writeHeartbeat();
		const heartbeatTimer = setInterval(writeHeartbeat, 1000);
		const stopHeartbeat = () => {
			heartbeatCleared = true;
			clearInterval(heartbeatTimer);
		};

		try {
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Bridge round-trip work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-bridge" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				persistentChildren: true,
			});

			// The runner appends `child_ready` when it registers the child; this
			// proves the bridge is usable before we send any follow-up request.
			await waitFor(() => readRelayIfExists(relayFile).includes("child_ready"), 20_000, "child_ready");

			const resultPath = await waitForAsyncResultFile(id);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { state?: string };
			assert.equal(payload.state, "complete");
			assert.ok(readRelayIfExists(relayFile).includes("child_settled"), "expected a child_settled marker after the run settled");

			// Follow-up prompt: forwarded via the requests watcher to the child's
			// RPC stdin; the child's response line must land back in the relay.
			const followUp: Record<string, unknown> = {
				id: "conv-followup-1",
				ts: Date.now(),
				type: "prompt",
				message: "Follow up: summarize the work.",
				streamingBehavior: { thinking: 1 },
			};
			fs.appendFileSync(requestsFile, `${JSON.stringify(followUp)}\n`, "utf-8");
			await waitFor(
				() => readRelayIfExists(relayFile).includes('"command":"prompt"') && readRelayIfExists(relayFile).includes("conv-followup-1"),
				15_000,
				"forwarded prompt response in relay",
			);
			// The mock echoes a response record (id preserved) only for commands it
			// actually processed — that is the proof the request reached the child.
			assert.ok(
				readRelayIfExists(relayFile).includes('"id":"conv-followup-1"') && readRelayIfExists(relayFile).includes('"command":"prompt"'),
				"expected the forwarded prompt echo in the relay",
			);

			// Ping is answered locally by the bridge with a pong marker.
			fs.appendFileSync(requestsFile, `${JSON.stringify({ id: "conv-ping-1", ts: Date.now(), type: "ping" })}\n`, "utf-8");
			await waitFor(() => readRelayIfExists(relayFile).includes('"requestId":"conv-ping-1"'), 15_000, "pong marker in relay");

			// Ending the conversation: removing the heartbeat lets the runner
			// exit; it closes the child (child_closed marker) and the process.
			stopHeartbeat();
			fs.rmSync(heartbeatFile, { force: true });
			await waitFor(() => readRelayIfExists(relayFile).includes('"child_closed"'), 20_000, "child_closed marker");

			// The runner process itself must exit once no conversation is alive.
			let runnerPid: number | undefined;
			try {
				const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as { pid?: number };
				runnerPid = status.pid;
			} catch {
				// status.json may be gone by now; the child_closed marker already
				// proves the runner finished closing children.
			}
			if (runnerPid !== undefined) {
				await waitFor(() => {
					try {
						process.kill(runnerPid as number, 0);
						return false;
					} catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						return code === "ESRCH";
					}
				}, 20_000, "runner process exit");
			}
		} finally {
			stopHeartbeat();
			// Always end the conversation so a failing assertion cannot leave the
			// runner lingering with a fresh heartbeat behind.
			try {
				fs.rmSync(heartbeatFile, { force: true });
			} catch {
				// Best-effort cleanup.
			}
		}
	});

	it("round-trips a follow-up prompt through the parent-side AsyncBridgeChannel", async () => {
		mockPi.onCall({ jsonl: [events.assistantMessage("bridge channel first reply")] });
		const id = `bridge-channel-rtt-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const stepKey = resolveConversationStepKey(0, "worker");
		const relayFile = relayFilePath(conversationDir(asyncDir), stepKey);
		const heartbeatFile = heartbeatFilePath(conversationDir(asyncDir), stepKey);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Bridge channel round-trip work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-bridge-channel" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
			persistentChildren: true,
		});

		// The channel opens before the child even spawns (queued-boot parity): its
		// tail starts at relay birth, so the child_settled marker appended at
		// settle is observed (and pre-run lines are collected harmlessly).
		const channel = createAsyncBridgeChannel(asyncDir, stepKey, {
			key: `${id}/0`,
			pollMs: 50,
			heartbeatIntervalMs: 500,
		});
		const received: string[] = [];
		channel.onStdoutLine((line) => received.push(line));

		try {
			// The bridge must be usable (child_ready) before any prompt is sent.
			await waitFor(() => readRelayIfExists(relayFile).includes("child_ready"), 20_000, "child_ready");
			assert.ok(fs.existsSync(heartbeatFile), "opening the channel must write the heartbeat immediately");

			await waitForAsyncResultFile(id);
			await waitFor(() => channel.settled, 20_000, "child_settled via the channel");

			// Follow-up prompt through the actual parent-side channel: the runner
			// watcher forwards it to the child stdin, and the child's response
			// lands back in the relay with the original request id preserved.
			const promptId = channel.write({ type: "prompt", message: "Follow up through the channel.", streamingBehavior: { thinking: 1 } });
			await waitFor(
				() => readRelayIfExists(relayFile).includes(`"id":"${promptId}"`) && readRelayIfExists(relayFile).includes('"command":"prompt"'),
				15_000,
				"channel prompt forwarded to the child",
			);
			await waitFor(() => received.some((line) => line.includes(`"id":"${promptId}"`)), 15_000, "prompt response delivered to the channel subscriber");

			// Prompts written through the channel land in the requests inbox.
			const requestsFile = requestsFilePath(conversationDir(asyncDir), stepKey);
			assert.ok(fs.existsSync(requestsFile), "requests file must exist after the channel write");

			// Closing the viewer side clears the heartbeat; the runner's linger
			// loop then closes the child and exits (child_closed marker).
			await channel.close("graceful");
			assert.equal(fs.existsSync(heartbeatFile), false, "closing the channel must clear the heartbeat");
			await waitFor(() => readRelayIfExists(relayFile).includes('"child_closed"'), 30_000, "child_closed after the channel closes");

			let runnerPid: number | undefined;
			try {
				const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as { pid?: number };
				runnerPid = status.pid;
			} catch {
				// status.json may be gone by now; child_closed already proves the
				// runner finished closing children.
			}
			if (runnerPid !== undefined) {
				await waitFor(() => {
					try {
						process.kill(runnerPid as number, 0);
						return false;
					} catch (error) {
						return (error as NodeJS.ErrnoException).code === "ESRCH";
					}
				}, 20_000, "runner process exit");
			}
		} finally {
			// A failing assertion must never leave the runner lingering with a
			// fresh heartbeat behind.
			try {
				fs.rmSync(heartbeatFile, { force: true });
			} catch {
				// Best-effort cleanup.
			}
		}
	});
});