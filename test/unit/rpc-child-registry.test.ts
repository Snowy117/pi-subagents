import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createRpcChildCloser,
	createRpcChildRegistry,
	type PersistentRpcChild,
} from "../../src/runs/persistent/rpc-child-registry.ts";

interface FakeProc {
	kill(signal?: string): boolean;
}

function makeChild(
	key: string,
	overrides: Partial<PersistentRpcChild> = {},
): PersistentRpcChild {
	const proc = overrides.proc as unknown as FakeProc ?? { kill: () => true };
	let closed = false;
	const closedPromise = new Promise<void>((resolve) => {
		// close() resolves via the closer's escalation path in tests; keep a
		// way to simulate process exit for graceful-close assertions.
		(proc as FakeProc & { _resolveClosed?: () => void })._resolveClosed = resolve;
		(proc as FakeProc & { _closed?: boolean })._closed = false;
	});
	return {
		key,
		sessionFile: overrides.sessionFile,
		proc: proc as never,
		write: {
			writeLine: () => true,
			write: () => "req",
			close: () => {
				(proc as FakeProc & { _stdinClosed?: boolean })._stdinClosed = true;
			},
		},
		settled: overrides.settled ?? true,
		lastActivityAt: overrides.lastActivityAt ?? 0,
		pendingDialogs: new Map(),
		pendingRequestIds: new Set(),
		closed: closedPromise,
		close: createRpcChildCloser(
			{
				key,
				sessionFile: overrides.sessionFile,
				proc: proc as never,
				write: {
					writeLine: () => true,
					write: () => "req",
					close: () => {
						(proc as FakeProc & { _stdinClosed?: boolean })._stdinClosed = true;
					},
				},
				settled: overrides.settled ?? true,
				lastActivityAt: overrides.lastActivityAt ?? 0,
				pendingDialogs: new Map(),
				pendingRequestIds: new Set(),
				closed: closedPromise,
			} as never,
			{
				closeGraceMs: 5,
				sigtermGraceMs: 5,
				sleep: async () => {},
			},
		),
		...overrides,
	};
}

describe("createRpcChildRegistry", () => {
	it("stores one entry per key; re-register replaces the handle", () => {
		const registry = createRpcChildRegistry();
		const child = makeChild("run-1/0");
		registry.register(child);
		assert.equal(registry.has("run-1/0"), true);
		assert.equal(registry.get("run-1/0"), child);
		// The one-writer invariant is enforced by callers checking has() before
		// register(); re-registering a key replaces the handle (last-writer-wins).
		const replacement = makeChild("run-1/0");
		registry.register(replacement);
		assert.equal(registry.get("run-1/0"), replacement);
		assert.equal(registry.entries().length, 1);
	});

	it("evicts idle settled children only", async () => {
		const now = () => 10_000;
		const registry = createRpcChildRegistry({ now });
		const active = makeChild("active", { settled: false, lastActivityAt: 9_000 });
		const idle = makeChild("idle", { settled: true, lastActivityAt: 1_000 });
		registry.register(active);
		registry.register(idle);
		const evicted = await registry.evictIdle(5_000);
		assert.deepEqual(evicted, ["idle"]);
		assert.equal(registry.has("idle"), false);
		assert.equal(registry.has("active"), true);
	});

	it("skips the active viewer target during idle eviction", async () => {
		const now = () => 10_000;
		const registry = createRpcChildRegistry({ now });
		const viewed = makeChild("viewed", { settled: true, lastActivityAt: 1_000 });
		const idle = makeChild("idle", { settled: true, lastActivityAt: 1_000 });
		registry.register(viewed);
		registry.register(idle);
		const evicted = await registry.evictIdle(5_000, { except: "viewed" });
		assert.deepEqual(evicted, ["idle"]);
		assert.equal(registry.has("viewed"), true);
		assert.equal(registry.has("idle"), false);
	});

	it("skips the active viewer target during overflow eviction", async () => {
		const now = () => 10_000;
		const registry = createRpcChildRegistry({ now });
		const viewed = makeChild("viewed", { settled: true, lastActivityAt: 1_000 });
		const older = makeChild("older", { settled: true, lastActivityAt: 2_000 });
		const newest = makeChild("newest", { settled: true, lastActivityAt: 3_000 });
		registry.register(viewed);
		registry.register(older);
		registry.register(newest);
		// Cap 1 with the viewed child excluded leaves two candidates; the
		// least-recently-active of those overflows and is evicted.
		const evicted = await registry.evictOverflow(1, { except: "viewed" });
		assert.deepEqual(evicted, ["older"]);
		assert.equal(registry.has("viewed"), true);
		assert.equal(registry.has("newest"), true);
		assert.equal(registry.has("older"), false);
	});

	it("evicts least-recently-active settled children over the cap", async () => {
		const registry = createRpcChildRegistry();
		const old = makeChild("old", { lastActivityAt: 100 });
		const mid = makeChild("mid", { lastActivityAt: 200 });
		const fresh = makeChild("fresh", { lastActivityAt: 300 });
		registry.register(old);
		registry.register(mid);
		registry.register(fresh);
		const evicted = await registry.evictOverflow(2);
		assert.deepEqual(evicted, ["old"]);
		assert.equal(registry.has("old"), false);
		assert.equal(registry.settledCount(), 2);
	});

	it("closeAll closes every resident child", async () => {
		const registry = createRpcChildRegistry();
		registry.register(makeChild("a"));
		registry.register(makeChild("b"));
		await registry.closeAll("graceful");
		assert.equal(registry.entries().length, 0);
	});
});

describe("createRpcChildCloser", () => {
	it("graceful close cancels pending dialogs and closes stdin", async () => {
		const proc = { kill: () => true };
		let stdinClosed = false;
		const dialogs = new Map<string, { resolve: (value: unknown) => void }>();
		const requestIds = new Set<string>();
		const closed = new Promise<void>(() => {});
		const child = {
			key: "k",
			proc: proc as never,
			write: {
				writeLine: () => true,
				write: () => "req",
				close: () => {
					stdinClosed = true;
				},
			},
			settled: true,
			lastActivityAt: 0,
			pendingDialogs: dialogs,
			pendingRequestIds: requestIds,
			closed,
		} as never;
		const closer = createRpcChildCloser(child, {
			closeGraceMs: 1,
			sigtermGraceMs: 1,
			sleep: async () => {},
		});
		dialogs.set("d1", { resolve: () => {} });
		requestIds.add("d1");
		await closer("graceful");
		assert.equal(stdinClosed, true);
		assert.equal(requestIds.size, 0);
		assert.equal(dialogs.size, 0);
	});

	it("force close skips stdin EOF and escalates to SIGTERM/SIGKILL", async () => {
		const signals: string[] = [];
		const proc = { kill: (signal?: string) => {
			if (signal) signals.push(signal);
			return false;
		} };
		let stdinClosed = false;
		const closed = new Promise<void>(() => {});
		const child = {
			key: "k",
			proc: proc as never,
			write: { writeLine: () => true, write: () => "req", close: () => {
				stdinClosed = true;
			} },
			settled: true,
			lastActivityAt: 0,
			pendingDialogs: new Map(),
			pendingRequestIds: new Set(),
			closed,
		} as never;
		const closer = createRpcChildCloser(child, {
			closeGraceMs: 0,
			sigtermGraceMs: 0,
			sleep: async () => {},
		});
		await closer("force");
		assert.equal(stdinClosed, false);
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	});
});
