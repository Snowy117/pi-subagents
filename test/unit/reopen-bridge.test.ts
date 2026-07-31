import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRpcChildRegistry } from "../../src/runs/persistent/rpc-child-registry.ts";
import { createReopenBridge } from "../../src/tui/steer-view/reopen-bridge.ts";
import type { SteerViewTarget } from "../../src/tui/steer-view/target-model.ts";

function makeTarget(overrides: Partial<SteerViewTarget> = {}): SteerViewTarget {
	return {
		key: "foreground:run-1:0",
		kind: "foreground",
		runId: "run-1",
		index: 0,
		agent: "worker",
		status: "completed",
		active: false,
		updatedAt: Date.now(),
		...overrides,
	};
}

describe("reopen bridge", () => {
	it("reopens an evicted child session with a fresh RPC process", () => {
		const registry = createRpcChildRegistry();
		let spawnArgs: string[] | undefined;
		const bridge = createReopenBridge({
			registry,
			cwd: "/tmp",
			getChildLaunchArgs: (target) => {
				spawnArgs = ["--mode", "rpc", "--session", target.sessionFile ?? "missing"];
				return spawnArgs;
			},
		});
		const target = makeTarget({ sessionFile: "/sessions/run-1.jsonl" });
		const resident = bridge.reopen(target);
		assert.ok(resident, "expected a reopened resident child");
		assert.equal(registry.has("run-1/0"), true);
		assert.equal(resident.key, "run-1/0");
		assert.equal(spawnArgs?.[0], "--mode");
		void bridge.close();
	});

	it("never reopens while a resident entry exists (one-writer guard)", () => {
		const registry = createRpcChildRegistry();
		const existing = {
			key: "run-1/0",
			proc: {} as never,
			write: { writeLine: () => true, write: () => "req", close: () => {} },
			settled: true,
			lastActivityAt: 0,
			pendingDialogs: new Map(),
			pendingRequestIds: new Set(),
			closed: new Promise(() => {}),
			close: async () => {},
		};
		registry.register(existing);
		let spawnCalled = false;
		const bridge = createReopenBridge({
			registry,
			cwd: "/tmp",
			getChildLaunchArgs: () => {
				spawnCalled = true;
				return ["--mode", "rpc"];
			},
		});
		const resident = bridge.reopen(makeTarget({ sessionFile: "/sessions/run-1.jsonl" }));
		assert.equal(resident, existing, "must reuse the resident entry");
		assert.equal(spawnCalled, false, "must not spawn a second writer");
	});

	it("returns undefined without a session file", () => {
		const registry = createRpcChildRegistry();
		const bridge = createReopenBridge({
			registry,
			cwd: "/tmp",
			getChildLaunchArgs: () => ["--mode", "rpc"],
		});
		const resident = bridge.reopen(makeTarget());
		assert.equal(resident, undefined);
		assert.equal(registry.entries().length, 0);
	});
});
