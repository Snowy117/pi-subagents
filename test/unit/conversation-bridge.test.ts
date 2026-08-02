import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearBridgeHeartbeats,
	conversationDir,
	createConversationRequestsWatcher,
	createRelayWriter,
	createRunnerConversationBridge,
	ensureConversationDir,
	isConversing,
	lingerForConversations,
	listConversationKeys,
	relayFilePath,
	requestsFilePath,
	resolveConversationStepKey,
	sanitizeStepKeyComponent,
	heartbeatFilePath,
} from "../../src/runs/background/runner/conversation-bridge.ts";
import type { RpcChildRegistry, PersistentRpcChild } from "../../src/runs/persistent/rpc-child-registry.ts";

let tempDir: string;

before(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-unit-"));
});
after(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});
beforeEach(() => {
	for (const entry of fs.readdirSync(tempDir)) {
		fs.rmSync(path.join(tempDir, entry), { recursive: true, force: true });
	}
});

function asyncDir(): string {
	const dir = path.join(tempDir, `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	return dir;
}

function makeFakeRegistry(children: Record<string, PersistentRpcChild> = {}): RpcChildRegistry {
	return {
		get(key) { return children[key]; },
		has(key) { return key in children; },
		entries() { return Object.values(children); },
		settledCount() { return Object.values(children).filter((c) => c.settled).length; },
		register(child) { children[child.key] = child; },
		unregister(key) { return delete children[key]; },
		async evictIdle() { return []; },
		async evictOverflow() { return []; },
		async closeAll() {},
	};
}

function makeResident(key: string, received: Array<Record<string, unknown>>): PersistentRpcChild {
	return {
		key,
		sessionFile: undefined,
		proc: { kill: () => true } as never,
		write: {
			writeLine: (line) => {
				received.push(JSON.parse(line) as Record<string, unknown>);
				return true;
			},
			write: (record) => {
				received.push(record);
				return String(record.id ?? "req");
			},
			close: () => {},
		},
		settled: true,
		lastActivityAt: Date.now(),
		pendingDialogs: new Map(),
		pendingRequestIds: new Set(),
		closed: new Promise(() => {}),
		close: async () => {},
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail("waitFor condition not met within timeout");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Read a relay file as "" when it does not exist yet (no line was appended). */
function readRelayIfExists(dir: string, stepKey: string): string {
	try {
		return fs.readFileSync(relayFilePath(dir, stepKey), "utf-8");
	} catch {
		return "";
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("stepKey sanitization and paths", () => {
	it("sanitizes filesystem-unsafe components with the artifact rule", () => {
		assert.equal(sanitizeStepKeyComponent("my agent/backend"), "my_agent_backend");
		assert.equal(sanitizeStepKeyComponent("worker"), "worker");
		assert.equal(sanitizeStepKeyComponent("a:b?*"), "a_b__");
	});

	it("resolveConversationStepKey puts the flat index first, then the agent", () => {
		assert.equal(resolveConversationStepKey(0, "worker"), "0-worker");
		assert.equal(resolveConversationStepKey(12, "my agent/backend"), "12-my_agent_backend");
		// A dashed agent stays unambiguous: the leading digit component splits it.
		assert.equal(resolveConversationStepKey(0, "my-agent"), "0-my-agent");
		// The parent must be able to parse the key back: index is everything
		// before the first dash.
		assert.equal(resolveConversationStepKey(0, "my-agent").split("-")[0], "0");
	});

	it("builds the three file paths under the conversation dir", () => {
		const dir = conversationDir(asyncDir());
		assert.equal(relayFilePath(dir, "0-worker"), path.join(dir, "0-worker.stdout.jsonl"));
		assert.equal(requestsFilePath(dir, "0-worker"), path.join(dir, "0-worker.requests.jsonl"));
		assert.equal(heartbeatFilePath(dir, "0-worker"), path.join(dir, "0-worker.active"));
	});

	it("ensureConversationDir creates the dir recursively", () => {
		const dir = asyncDir();
		ensureConversationDir(dir);
		assert.equal(fs.existsSync(conversationDir(dir)), true);
	});
});

describe("relay writer", () => {
	it("appends LF-framed lines verbatim and stamps markers with key/stepKey/ts", () => {
		const dir = asyncDir();
		const relay = createRelayWriter({ dir, stepKey: "0-worker", deps: { now: () => 1000 } });
		relay.appendLine('{"type":"message_end","message":{"role":"assistant"}}');
		relay.appendMarker({ type: "child_ready", key: "run-1/0" });
		relay.appendMarker({ type: "child_settled", key: "run-1/0" });
		const content = fs.readFileSync(relayFilePath(dir, "0-worker"), "utf-8");
		const lines = content.split("\n").filter((l) => l.length > 0);
		assert.equal(lines.length, 3);
		assert.deepEqual(JSON.parse(lines[0]), { type: "message_end", message: { role: "assistant" } });
		const ready = JSON.parse(lines[1]) as Record<string, unknown>;
		assert.equal(ready.type, "child_ready");
		assert.equal(ready.key, "run-1/0");
		assert.equal(ready.stepKey, "0-worker");
		assert.equal(ready.ts, 1000);
	});

	it("skips empty lines", () => {
		const dir = asyncDir();
		const relay = createRelayWriter({ dir, stepKey: "0-worker" });
		relay.appendLine("");
		relay.appendLine("   ");
		let content = "";
		try {
			content = fs.readFileSync(relayFilePath(dir, "0-worker"), "utf-8");
		} catch {
			// No non-empty line was ever appended, so the file may not exist.
		}
		assert.equal(content, "");
	});

	it("truncates to the tail and writes a relay_reset marker when the cap is hit", () => {
		const dir = asyncDir();
		const relay = createRelayWriter({
			dir,
			stepKey: "0-worker",
			deps: { maxBytes: 120, now: () => 5 },
		});
		for (let i = 0; i < 30; i++) relay.appendLine(JSON.stringify({ n: i }));
		const content = fs.readFileSync(relayFilePath(dir, "0-worker"), "utf-8");
		const lines = content.split("\n").filter((l) => l.length > 0);
		// The first line after truncation must be the relay_reset marker.
		assert.equal(JSON.parse(lines[0]).type, "relay_reset");
		assert.equal(JSON.parse(lines[0]).key, "0-worker");
		// Old lines are gone; the latest lines survive the tail reservation.
		const nums = lines.slice(1).map((line) => JSON.parse(line).n);
		assert.ok(!nums.includes(0));
		assert.ok(nums.includes(29));
	});
});

describe("requests watcher", () => {
	it("forwards operational key-route commands (abort/model/thinking) verbatim", async () => {
		const dir = asyncDir();
		const received: Array<Record<string, unknown>> = [];
		const registry = makeFakeRegistry({ "run-1/0": makeResident("run-1/0", received) });
		const watcher = createConversationRequestsWatcher({
			dir,
			stepKey: "0-worker",
			registry,
			registryKey: "run-1/0",
			relayWriter: createRelayWriter({ dir, stepKey: "0-worker" }),
			deps: { pollMs: 10 },
		});
		watcher.start();
		const records = [
			{ id: "a1", ts: 100, type: "abort" },
			{ id: "a2", ts: 200, type: "cycle_model" },
			{ id: "a3", ts: 300, type: "get_available_models" },
			{ id: "a4", ts: 400, type: "set_model", provider: "p", modelId: "m" },
			{ id: "a5", ts: 500, type: "cycle_thinking_level" },
			{ id: "a6", ts: 600, type: "get_state" },
		];
		for (const record of records) {
			fs.appendFileSync(requestsFilePath(dir, "0-worker"), JSON.stringify(record) + "\n");
		}
		await waitFor(() => received.length === records.length);
		assert.deepEqual(received.map((r) => r.type), records.map((r) => r.type));
		assert.deepEqual(received.map((r) => r.id), records.map((r) => r.id));
		// A viewer-hostile session mutation is NOT forwardable.
		fs.appendFileSync(requestsFilePath(dir, "0-worker"), JSON.stringify({ id: "x1", ts: 700, type: "switch_session", sessionPath: "/tmp/x" }) + "\n");
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(received.length, records.length);
		watcher.stop();
	});

	it("forwards prompt/get_commands records verbatim to the resident child", async () => {
		const dir = asyncDir();
		const received: Array<Record<string, unknown>> = [];
		const registry = makeFakeRegistry({ "run-1/0": makeResident("run-1/0", received) });
		const watcher = createConversationRequestsWatcher({
			dir,
			stepKey: "0-worker",
			registry,
			registryKey: "run-1/0",
			relayWriter: createRelayWriter({ dir, stepKey: "0-worker" }),
			deps: { pollMs: 10 },
		});
		watcher.start();
		fs.appendFileSync(requestsFilePath(dir, "0-worker"), JSON.stringify({
			id: "r1", ts: 100, type: "prompt", message: "hello", streamingBehavior: { thinking: 1 }, images: [{ path: "a.png" }],
		}) + "\n");
		await waitFor(() => received.length === 1);
		assert.deepEqual(received[0], {
			id: "r1", ts: 100, type: "prompt", message: "hello", streamingBehavior: { thinking: 1 }, images: [{ path: "a.png" }],
		});
		fs.appendFileSync(requestsFilePath(dir, "0-worker"), JSON.stringify({
			id: "r2", ts: 200, type: "get_commands",
		}) + "\n");
		await waitFor(() => received.length === 2);
		assert.equal(received[1]?.type, "get_commands");
		assert.equal(received[1]?.id, "r2");
		watcher.stop();
	});

	it("answers ping with a pong marker in the relay", async () => {
		const dir = asyncDir();
		const registry = makeFakeRegistry({ "run-1/0": makeResident("run-1/0", []) });
		const relayWriter = createRelayWriter({ dir, stepKey: "0-worker", deps: { now: () => 42 } });
		const watcher = createConversationRequestsWatcher({
			dir, stepKey: "0-worker", registry, registryKey: "run-1/0", relayWriter,
			deps: { pollMs: 10 },
		});
		watcher.start();
		fs.appendFileSync(requestsFilePath(dir, "0-worker"), JSON.stringify({
			id: "ping-1", ts: 300, type: "ping",
		}) + "\n");
		await waitFor(() => readRelayIfExists(dir, "0-worker").includes("pong"));
		const marker = JSON.parse(readRelayIfExists(dir, "0-worker").trim());
		assert.equal(marker.type, "pong");
		assert.equal(marker.key, "run-1/0");
		assert.equal(marker.stepKey, "0-worker");
		assert.equal(marker.requestId, "ping-1");
		assert.equal(marker.ts, 42);
		watcher.stop();
	});

	it("writes child_unavailable when no resident child exists", async () => {
		const dir = asyncDir();
		const registry = makeFakeRegistry({});
		const watcher = createConversationRequestsWatcher({
			dir, stepKey: "0-worker", registry, registryKey: "run-1/0",
			relayWriter: createRelayWriter({ dir, stepKey: "0-worker" }),
			deps: { pollMs: 10, launchGraceMs: 0 },
		});
		watcher.start();
		fs.appendFileSync(requestsFilePath(dir, "0-worker"), JSON.stringify({
			id: "r1", ts: 100, type: "prompt", message: "hi",
		}) + "\n");
		await waitFor(() => readRelayIfExists(dir, "0-worker").includes("child_unavailable"));
		const marker = JSON.parse(readRelayIfExists(dir, "0-worker").trim());
		assert.equal(marker.type, "child_unavailable");
		assert.equal(marker.reason, "no-resident");
		watcher.stop();
	});

	it("buffers requests arriving during the launch window and forwards once the child registers", async () => {
		const dir = asyncDir();
		const received: Array<Record<string, unknown>> = [];
		const children: Record<string, PersistentRpcChild> = {};
		const registry = makeFakeRegistry(children);
		const watcher = createConversationRequestsWatcher({
			dir, stepKey: "0-worker", registry, registryKey: "run-1/0",
			relayWriter: createRelayWriter({ dir, stepKey: "0-worker" }),
			deps: { pollMs: 10, launchGraceMs: 2000 },
		});
		watcher.start();
		fs.appendFileSync(requestsFilePath(dir, "0-worker"), JSON.stringify({
			id: "early", ts: 100, type: "prompt", message: "early",
		}) + "\n");
		await sleep(60);
		// No resident yet → no marker, no forward; the request is held.
		assert.equal(received.length, 0);
		assert.equal(readRelayIfExists(dir, "0-worker"), "");
		children["run-1/0"] = makeResident("run-1/0", received);
		await waitFor(() => received.length === 1);
		assert.equal(received[0]?.id, "early");
		watcher.stop();
	});

	it("expires buffered requests to child_unavailable after the launch window", async () => {
		const dir = asyncDir();
		const registry = makeFakeRegistry({});
		const watcher = createConversationRequestsWatcher({
			dir, stepKey: "0-worker", registry, registryKey: "run-1/0",
			relayWriter: createRelayWriter({ dir, stepKey: "0-worker" }),
			deps: { pollMs: 10, launchGraceMs: 40 },
		});
		watcher.start();
		fs.appendFileSync(requestsFilePath(dir, "0-worker"), JSON.stringify({
			id: "stale", ts: 100, type: "prompt", message: "stale",
		}) + "\n");
		await sleep(120);
		const content = readRelayIfExists(dir, "0-worker");
		assert.ok(content.includes("child_unavailable"), content);
		watcher.stop();
	});

	it("skips malformed lines and resyncs when the requests file is truncated", async () => {
		const dir = asyncDir();
		const received: Array<Record<string, unknown>> = [];
		const registry = makeFakeRegistry({ "run-1/0": makeResident("run-1/0", received) });
		const watcher = createConversationRequestsWatcher({
			dir, stepKey: "0-worker", registry, registryKey: "run-1/0",
			relayWriter: createRelayWriter({ dir, stepKey: "0-worker" }),
			deps: { pollMs: 10 },
		});
		watcher.start();
		const file = requestsFilePath(dir, "0-worker");
		fs.appendFileSync(file, "not-json\n");
		fs.appendFileSync(file, JSON.stringify({ id: 5, ts: "x", type: "prompt" }) + "\n");
		fs.appendFileSync(file, JSON.stringify({ id: "ok", ts: 1, type: "prompt", message: "fine" }) + "\n");
		await waitFor(() => received.length === 1);
		assert.equal(received[0]?.id, "ok");
		// Truncation resync: replace the file entirely; the new record is picked up.
		fs.writeFileSync(file, JSON.stringify({ id: "after-trunc", ts: 2, type: "prompt", message: "again" }) + "\n");
		await waitFor(() => received.length === 2);
		assert.equal(received[1]?.id, "after-trunc");
		watcher.stop();
	});
});

describe("heartbeat freshness", () => {
	it("isConversing respects the TTL boundary", () => {
		const dir = asyncDir();
		const file = heartbeatFilePath(conversationDir(dir), "0-worker");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ ts: 1_000_000 }));
		assert.equal(isConversing(dir, "0-worker", 1_029_999, 30_000), true);
		assert.equal(isConversing(dir, "0-worker", 1_030_000, 30_000), true);
		assert.equal(isConversing(dir, "0-worker", 1_030_001, 30_000), false);
	});

	it("isConversing is false for missing, malformed, or empty heartbeats", () => {
		const dir = asyncDir();
		assert.equal(isConversing(dir, "nope"), false);
		const file = heartbeatFilePath(conversationDir(dir), "0-worker");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "not-json");
		assert.equal(isConversing(dir, "0-worker"), false);
		fs.writeFileSync(file, JSON.stringify({}));
		assert.equal(isConversing(dir, "0-worker"), false);
		fs.writeFileSync(file, JSON.stringify({ ts: "1000" }));
		assert.equal(isConversing(dir, "0-worker"), false);
	});

	it("listConversationKeys and clearBridgeHeartbeats remove exactly the active files", () => {
		const dir = asyncDir();
		ensureConversationDir(dir);
		fs.writeFileSync(heartbeatFilePath(conversationDir(dir), "0-worker"), JSON.stringify({ ts: 1 }));
		fs.writeFileSync(heartbeatFilePath(conversationDir(dir), "1-a"), JSON.stringify({ ts: 1 }));
		assert.deepEqual(listConversationKeys(dir).sort(), ["0-worker", "1-a"]);
		clearBridgeHeartbeats(dir);
		assert.equal(isConversing(dir, "0-worker"), false);
		assert.equal(isConversing(dir, "1-a"), false);
		// Only heartbeat (.active) files are removed; the conversation dir remains.
		assert.equal(fs.existsSync(conversationDir(dir)), true);
	});
});

describe("runner conversation bridge + linger", () => {
	it("relayFor is idempotent per stepKey and wires markers into the relay", () => {
		const dir = asyncDir();
		const bridge = createRunnerConversationBridge({ asyncDir: dir, registry: makeFakeRegistry() });
		const first = bridge.relayFor("worker", 0, "run-1/0");
		const second = bridge.relayFor("worker", 0, "run-1/0");
		assert.equal(first, second);
		first.appendMarker({ type: "child_ready", key: "run-1/0" });
		const content = fs.readFileSync(relayFilePath(conversationDir(dir), "0-worker"), "utf-8");
		assert.ok(content.includes("child_ready"));
		// conversingKeys follows the heartbeat file, not the marker.
		assert.equal(bridge.conversingKeys().size, 0);
		fs.writeFileSync(heartbeatFilePath(conversationDir(dir), "0-worker"), JSON.stringify({ ts: Date.now() }));
		assert.deepEqual(bridge.conversingKeys(), new Set(["0-worker"]));
		assert.deepEqual(bridge.conversingRegistryKeys(), ["run-1/0"]);
		bridge.stopAll();
		bridge.clearHeartbeats();
		assert.equal(bridge.conversingKeys().size, 0);
	});

	it("lingerForConversations exits when no child is conversing", async () => {
		const bridge = {
			conversingKeys: () => new Set<string>(),
		};
		let sleeps = 0;
		await lingerForConversations({
			bridge: bridge as never,
			deps: { now: () => 0, sleep: async () => { sleeps++; }, maxLingerMs: 5000, tickMs: 10 },
		});
		assert.equal(sleeps, 0);
	});

	it("lingerForConversations keeps waiting while conversing and stops at the cap", async () => {
		let now = 0;
		const bridge = {
			conversingKeys: () => new Set<string>(["0-worker"]),
		};
		await lingerForConversations({
			bridge: bridge as never,
			deps: {
				now: () => now,
				sleep: async () => { now += 10; },
				maxLingerMs: 100,
				tickMs: 10,
			},
		});
		// Loops until the deadline: the sleep advances now to exactly the cap,
		// and the next iteration returns before ticking again.
		assert.equal(now, 100);
	});

	it("lingerForConversations returns as soon as the conversation ends", async () => {
		let now = 0;
		let conversing = true;
		const bridge = {
			conversingKeys: () => (conversing ? new Set<string>(["0-worker"]) : new Set<string>()),
		};
		const promise = lingerForConversations({
			bridge: bridge as never,
			deps: {
				now: () => now,
				sleep: async () => { now += 10; if (now >= 30) conversing = false; },
				maxLingerMs: 5000,
				tickMs: 10,
			},
		});
		await promise;
		assert.equal(now, 30);
	});
});