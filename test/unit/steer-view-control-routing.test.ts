import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { consumeSteerRequests } from "../../src/runs/background/control-channel.ts";
import { claimControlActionRequests } from "../../src/runs/shared/control-actions/channel.ts";
import { requestTargetThinkingCycle, sendTargetSteer } from "../../src/tui/steer-view/control-routing.ts";
import type { SteerViewTarget } from "../../src/tui/steer-view/target-model.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function asyncTarget(status: "running" | "complete" = "running"): SteerViewTarget {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "steer-routing-"));
	roots.push(asyncDir);
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: path.basename(asyncDir), mode: "single", state: status,
		pid: process.pid, cwd: asyncDir, startedAt: 1, lastUpdate: Date.now(),
		steps: [{ agent: "worker", status: status === "running" ? "running" : "complete" }],
	}));
	return {
		key: `async:${path.basename(asyncDir)}:0`, kind: "async", runId: path.basename(asyncDir),
		index: 0, agent: "worker", status, active: status === "running", updatedAt: Date.now(),
		asyncDir, actionControlDir: path.join(asyncDir, "control", "action-targets", "0"),
	};
}

describe("steer view control routing", () => {
	it("reconciles an async child before routing steer and action requests", () => {
		const target = asyncTarget();
		sendTargetSteer(target, "guide", { id: () => "steer-id", now: () => 10 });
		assert.equal(consumeSteerRequests(target.asyncDir!)[0]?.targetIndex, 0);
		const action = requestTargetThinkingCycle(target);
		assert.equal(claimControlActionRequests(target.actionControlDir!)[0]?.id, action.id);
	});

	it("rejects stale targets and out-of-range child indexes", () => {
		const terminal = asyncTarget("complete");
		terminal.active = true;
		assert.throws(() => sendTargetSteer(terminal, "late"), /no longer running or queued/);
		const missing = asyncTarget();
		missing.index = 3;
		assert.throws(() => requestTargetThinkingCycle(missing), /out of range/);
	});
});
