import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeAgentConfigs, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";
import { available, createSubagentExecutor, runSync } from "../support/single-execution-harness.ts";
import { createRpcChildRegistry } from "../../src/runs/persistent/rpc-child-registry.ts";

describe("foreground persistent RPC child", { skip: !available ? "pi packages not available" : undefined }, () => {
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

	function makeRegistry() {
		return createRpcChildRegistry();
	}

	it("launches --mode rpc and keeps the process resident after agent_settled", async () => {
		const registry = makeRegistry();
		mockPi.onCall({ jsonl: [events.assistantMessage("done")] });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "rpc-run-1",
			persistentChildren: true,
			persistentChildRegistry: registry,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		// The resident child is parked in the registry for later viewer turns.
		const resident = registry.get("rpc-run-1/0");
		assert.ok(resident, "expected a resident registry entry after settle");
		assert.equal(resident.settled, true);
		await registry.closeAll("graceful");
	});

	it("sends the task over stdin (no positional task text) in RPC mode", async () => {
		const registry = makeRegistry();
		mockPi.onCall({ jsonl: [events.assistantMessage("done")] });
		const agents = makeAgentConfigs(["echo"]);

		await runSync(tempDir, agents, "echo", "RPC task text", {
			runId: "rpc-run-2",
			persistentChildren: true,
			persistentChildRegistry: registry,
		});

		const callFile = mockPi.dir;
		const callPayload = mockPi.callCount();
		assert.equal(callPayload, 1);
		const calls = fs.readdirSync(callFile).filter((name) => name.startsWith("call-"));
		const payload = JSON.parse(fs.readFileSync(path.join(callFile, calls[0]), "utf-8")) as { args: string[] };
		assert.ok(payload.args.includes("--mode"));
		const modeIdx = payload.args.indexOf("--mode");
		assert.equal(payload.args[modeIdx + 1], "rpc");
		assert.ok(!payload.args.some((arg) => arg.startsWith("Task:")), "task must be delivered over stdin, not argv");
		await registry.closeAll("graceful");
	});

	it("evicts a settled child gracefully and drops it from the registry", async () => {
		const registry = makeRegistry();
		mockPi.onCall({ jsonl: [events.assistantMessage("done")] });
		const agents = makeAgentConfigs(["echo"]);

		await runSync(tempDir, agents, "echo", "Task", {
			runId: "rpc-run-3",
			persistentChildren: true,
			persistentChildRegistry: registry,
		});

		const evicted = await registry.evictIdle(0);
		assert.deepEqual(evicted, ["rpc-run-3/0"]);
		assert.equal(registry.has("rpc-run-3/0"), false);
	});

	it("legacy persistentChildren:false is ignored — child is always RPC mode", async () => {
		const registry = makeRegistry();
		mockPi.onCall({ jsonl: [events.assistantMessage("done")] });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "json-run-1",
			persistentChildren: false,
			persistentChildRegistry: registry,
		});

		assert.equal(result.exitCode, 0);
		const resident = registry.get("json-run-1/0");
		assert.ok(resident, "expected a resident registry entry — persistentChildren:false is now ignored, RPC mode is always used");
		assert.equal(resident.settled, true);
		await registry.closeAll("graceful");
	});

	it("executor injects persistentChildren from config with default true", async () => {
		const registry = makeRegistry();
		mockPi.onCall({ jsonl: [events.assistantMessage("done")] });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: { persistentChildren: true },
			asyncByDefault: false,
			persistentChildRegistry: registry,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("echo")] }),
		});

		const result = await executor.execute(
			"x",
			{ agent: "echo", task: "Task", cwd: tempDir },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.ok(!result.isError, `executor should succeed: ${JSON.stringify(result)}`);
		const resident = registry.entries();
		assert.equal(resident.length, 1);
		await registry.closeAll("graceful");
	});
});
