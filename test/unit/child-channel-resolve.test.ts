import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { conversationDir, relayFilePath, resolveConversationStepKey } from "../../src/runs/background/runner/conversation-bridge.ts";
import { createChildChannelResolver, type ResolveChildChannel } from "../../src/tui/steer-view/child-channel.ts";
import type { PersistentRpcChild } from "../../src/runs/persistent/rpc-child-registry.ts";
import type { SteerViewTarget } from "../../src/tui/steer-view/target-model.ts";
import type { ReopenBridge } from "../../src/tui/steer-view/reopen-bridge.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let currentAsyncDir = "";

function makeTarget(overrides: Partial<SteerViewTarget> = {}): SteerViewTarget {
	return {
		key: "async:run-1:0",
		kind: "async",
		runId: "run-1",
		index: 0,
		agent: "worker",
		status: "running",
		active: true,
		updatedAt: Date.now(),
		asyncDir: currentAsyncDir,
		...overrides,
	};
}

function makeResident(overrides: Partial<PersistentRpcChild> = {}): PersistentRpcChild & { sent: Array<Record<string, unknown>> } {
	const sent: Array<Record<string, unknown>> = [];
	const rpcWrite = {
		writeLine: () => true,
		write: (command: Record<string, unknown>) => { sent.push(command); return "id"; },
		close: () => {},
	};
	return {
		key: "run-1/0",
		sessionFile: undefined,
		proc: { stdout: new EventEmitter() as never, exitCode: null } as never,
		write: rpcWrite,
		sent,
		settled: true,
		lastActivityAt: 0,
		pendingDialogs: new Map(),
		pendingRequestIds: new Set(),
		closed: new Promise<void>(() => {}),
		close: async () => {},
		...overrides,
	};
}

function makeReopenBridge(reopen: (target: SteerViewTarget) => PersistentRpcChild | undefined): ReopenBridge {
	return { reopen, close() {} };
}

describe("resolveChildChannel", () => {
	let tempDir: string;
	let asyncDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "child-channel-resolve-"));
		asyncDir = path.join(tempDir, "async", "run-1");
		currentAsyncDir = asyncDir;
		fs.mkdirSync(asyncDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const writeStatus = (state: string, pid?: number): void => {
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state, ...(pid !== undefined ? { pid } : {}) }), "utf-8");
	};
	const ensureBridgeDir = (): string => fs.mkdirSync(conversationDir(asyncDir), { recursive: true });
	const makeResolver = (options: {
		resident?: (target: SteerViewTarget) => PersistentRpcChild | undefined;
		reopen?: (target: SteerViewTarget) => PersistentRpcChild | undefined;
		kill?: () => boolean;
	} = {}): { resolve: ResolveChildChannel; reopens: SteerViewTarget[] } => {
		const reopens: SteerViewTarget[] = [];
		const bridge = makeReopenBridge((target) => {
			reopens.push(target);
			return options.reopen?.(target);
		});
		let pidAlive = true;
		const resolver = createChildChannelResolver({
			getForegroundResident: (target) => (options.resident ? options.resident(target) : undefined),
			reopenBridge: bridge,
			fs,
			kill: options.kill ?? (() => pidAlive),
			resolvePollMs: 10,
			bridgeBootRetryMs: 200,
			pidDeathWaitMs: 300,
		});
		return { resolve: resolver, reopens };
	};

	it("resolves a foreground resident directly without reopening", async () => {
		const resident = makeResident();
		const { resolve, reopens } = makeResolver({ resident: () => resident });
		const channel = await resolve({} as never, makeTarget({ kind: "foreground", key: "foreground:run-1:0" }));
		assert.ok(channel, "a resident foreground child must resolve");
		assert.equal(channel!.key, "run-1/0");
		const id = channel!.write({ type: "prompt", message: "hi" });
		assert.ok(id);
		assert.equal(resident.sent.length, 1);
		assert.equal(reopens.length, 0, "a live resident must not be reopened");
	});

	it("resolves an evicted foreground child via registry-guarded reopen", async () => {
		const reopened = makeResident();
		const { resolve, reopens } = makeResolver({ reopen: () => reopened });
		const target = makeTarget({ kind: "foreground", key: "foreground:run-1:0", sessionFile: path.join(tempDir, "fg-session.jsonl") });
		const channel = await resolve({} as never, target);
		assert.ok(channel);
		assert.equal(reopens.length, 1);
		assert.equal(reopens[0], target);
		channel!.write({ type: "prompt", message: "hi" });
		assert.equal(reopened.sent.length, 1);
	});

	it("returns undefined for a foreground target with no resident and no session file", async () => {
		const { resolve } = makeResolver();
		const channel = await resolve({} as never, makeTarget({ kind: "foreground", key: "foreground:run-1:0" }));
		assert.equal(channel, undefined);
	});

	it("resolves an async queued run through the bridge when the runner bridge dir exists", async () => {
		ensureBridgeDir();
		const { resolve, reopens } = makeResolver();
		const channel = await resolve({} as never, makeTarget());
		assert.ok(channel, "a queued run with the bridge up must resolve to an AsyncBridgeChannel");
		assert.equal(channel!.key, "run-1/0");
		const id = channel!.write({ type: "prompt", message: "hello" });
		assert.ok(id);
		const requestsPath = path.join(conversationDir(asyncDir), `${resolveConversationStepKey(0, "worker")}.requests.jsonl`);
		const lines = fs.readFileSync(requestsPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { type?: string; message?: string; id?: string });
		assert.equal(lines.length, 1);
		assert.equal(lines[0]!.type, "prompt");
		assert.equal(lines[0]!.message, "hello");
		assert.equal(lines[0]!.id, id);
		assert.equal(reopens.length, 0);
		await channel!.close("graceful");
	});

	it("boot-retries a queued run until the runner bridge dir appears", async () => {
		const { resolve } = makeResolver();
		const immediate = resolve({} as never, makeTarget());
		await sleep(30);
		ensureBridgeDir();
		const channel = await immediate;
		assert.ok(channel, "the bridge must appear during the bounded boot window");
		await channel!.close("force");
	});

	it("gives up when the bridge never appears within the boot budget", async () => {
		const { resolve } = makeResolver({ kill: () => true });
		const channel = await resolve({} as never, makeTarget());
		assert.equal(channel, undefined);
	});

	it("falls through when the runner dies during boot", async () => {
		writeStatus("running", 42);
		const { resolve } = makeResolver({ kill: () => false });
		const channel = await resolve({} as never, makeTarget());
		assert.equal(channel, undefined, "a dead runner during boot must fall through");
	});

	it("refuses a running-run child whose relay already has a terminal marker", async () => {
		ensureBridgeDir();
		writeStatus("running", 42);
		fs.appendFileSync(relayFilePath(conversationDir(asyncDir), resolveConversationStepKey(0, "worker")), `${JSON.stringify({ type: "child_closed", key: "run-1/0", reason: "exit:1" })}\n`, "utf-8");
		const { resolve } = makeResolver({ kill: () => true });
		const channel = await resolve({} as never, makeTarget());
		assert.equal(channel, undefined, "a dead mid-run child cannot be conversed with until the run is terminal");
	});

	it("waits for the runner pid to die before reopening a terminal async child", async () => {
		writeStatus("complete", 42);
		const reopened = makeResident({ key: "run-1/0" });
		const reopens: SteerViewTarget[] = [];
		let pidAlive = true;
		const resolver = createChildChannelResolver({
			getForegroundResident: () => undefined,
			reopenBridge: makeReopenBridge((target) => { reopens.push(target); return reopened; }),
			fs,
			kill: () => pidAlive,
			resolvePollMs: 10,
			pidDeathWaitMs: 500,
		});
		const target = makeTarget({ status: "complete", sessionFile: path.join(tempDir, "session.jsonl") });
		const pending = resolver({} as never, target);
		await sleep(30);
		pidAlive = false;
		const channel = await pending;
		assert.ok(channel, "reopen must succeed after the runner pid dies");
		assert.equal(reopens.length, 1);
		channel!.write({ type: "prompt", message: "hi" });
		assert.equal(reopened.sent.length, 1);
	});

	it("gives up reopening a terminal async child whose runner never dies", async () => {
		writeStatus("failed", 42);
		const { resolve, reopens } = makeResolver({ kill: () => true });
		const channel = await resolve({} as never, makeTarget({ status: "failed", sessionFile: path.join(tempDir, "session.jsonl") }));
		assert.equal(channel, undefined, "continuity is unavailable when the runner cannot be confirmed dead");
		assert.equal(reopens.length, 0, "reopen must be registry-guarded by the pid-death confirm");
	});

	it("reopens immediately when the terminal runner pid is already dead", async () => {
		writeStatus("complete", 42);
		const reopened = makeResident({ key: "run-1/0" });
		const { resolve, reopens } = makeResolver({ reopen: () => reopened, kill: () => false });
		const channel = await resolve({} as never, makeTarget({ status: "complete", sessionFile: path.join(tempDir, "session.jsonl") }));
		assert.ok(channel, "a confirmed-dead runner allows immediate reopen");
		assert.equal(reopens.length, 1);
	});

	it("returns undefined for a terminal async child with no session file", async () => {
		writeStatus("complete", 42);
		const { resolve, reopens } = makeResolver({ kill: () => false });
		const channel = await resolve({} as never, makeTarget({ status: "complete" }));
		assert.equal(channel, undefined, "--no-session children have no continuity");
		assert.equal(reopens.length, 0);
	});

	it("treats a missing status file as queued (bridge path)", async () => {
		ensureBridgeDir();
		const { resolve } = makeResolver({ kill: () => true });
		const channel = await resolve({} as never, makeTarget());
		assert.ok(channel, "no status.json yet (runner not started) must use the bridge path");
		await channel!.close("graceful");
	});

	it("uses the listRuns fallback for the run state when status.json is missing", async () => {
		const reopened = makeResident({ key: "run-1/0" });
		const { resolve, reopens } = makeResolver({ reopen: () => reopened, kill: () => false });
		const resolver = createChildChannelResolver({
			getForegroundResident: () => undefined,
			reopenBridge: makeReopenBridge((target) => { reopens.push(target); return reopened; }),
			fs,
			kill: () => false,
			resolvePollMs: 10,
			listRuns: () => [{ id: "run-1", state: "complete" } as never],
		});
		const channel = await resolver({} as never, makeTarget({ status: "complete", sessionFile: path.join(tempDir, "session.jsonl") }));
		assert.ok(channel, "a terminal state from listRuns must drive the reopen path");
		assert.equal(reopens.length, 1);
	});
});