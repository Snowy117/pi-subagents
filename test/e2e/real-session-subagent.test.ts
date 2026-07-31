/**
 * Real Pi-session end-to-end test for the subagent extension.
 *
 * Spawns an actual child `pi` subprocess (a repo-local child CLI that runs a
 * real `AgentSession` backed by a faux provider) and exercises the extension's
 * real foreground execution path: the parent session calls the `subagent` tool,
 * the tool spawns the child, the child streams jsonl events, the extension's
 * real stdout parser extracts the result, and the marker flows back as a tool
 * result that the parent relays. No real API keys are used.
 *
 * Skips gracefully when the pi runtime packages are not importable.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { consumeControlActionResponses, requestControlAction } from "../../src/runs/shared/control-actions/channel.ts";
import { actionTargetDir, foregroundControlRoot, foregroundSteerInboxDir, FOREGROUND_RUNS_DIR } from "../../src/runs/shared/control-actions/paths.ts";
import { steerDeliveryMarker, writeSteerRequestToDir } from "../../src/runs/background/control-channel.ts";
import { liveTranscriptPath, retainLiveTranscript } from "../../src/shared/live-transcript.ts";
import { tryImport } from "../support/helpers.ts";
import type { RealSessionRun } from "../support/real-session-runner.ts";

const piCodingAgent = await tryImport<unknown>("@earendil-works/pi-coding-agent");
const piAi = await tryImport<unknown>("@earendil-works/pi-ai");
const available = Boolean(piCodingAgent && piAi);

const CHILD_MARKER = "CHILD_REAL_SESSION_OK";
const INTERACTIVE_MARKER = "CHILD_INTERACTIVE_CONTROL_OK";
// Env vars the runner must clear so a parent that was itself spawned as a
// subagent child can still launch fresh children. The values are deliberately
// bogus sentinels (nonexistent paths) so a leaked value would break spawning.
const BOGUS_EXTRA_DIRS = path.join(os.tmpdir(), "nonexistent-pi-subagents-e2e-extra-dirs");
const BOGUS_PI_BINARY = path.join(os.tmpdir(), "nonexistent-pi-binary-e2e");
const BOGUS_PI_PACKAGE_ROOT = path.join(os.tmpdir(), "nonexistent-pi-coding-agent-package-root-e2e");
const ISOLATED_ENV_KEYS = [
	"PI_SUBAGENT_E2E_JSON_CHILD",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_FANOUT_CHILD",
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_MAX_DEPTH",
	"PI_SUBAGENT_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_PARENT_SESSION",
	"PI_SUBAGENT_PI_BINARY",
	"PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
] as const;

describe("real Pi-session subagent E2E", { skip: !available ? "pi runtime packages not available" : undefined }, () => {
	let run: RealSessionRun | undefined;

	const E2E_JSON_ENV = "PI_SUBAGENT_E2E_JSON_CHILD";
	afterEach(async () => {
		await run?.dispose();
		run = undefined;
		delete process.env[E2E_JSON_ENV];
	});
	beforeEach(() => {
		// The e2e harness drives the json child path; the extension must not
		// default to persistent RPC children for this legacy transport test.
		process.env[E2E_JSON_ENV] = "1";
	});

	it("boots the extension in a real parent session and delivers a faux child result", async () => {
		const { routeParentThroughSubagent, runRealSubagentSession, subagentToolResults } = await import("../support/real-session-runner.ts");

		const previousEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
		// The e2e harness drives the json child path; the extension must not
		// default to persistent RPC children for this legacy transport test.
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_FANOUT_CHILD = "1";
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_MAX_DEPTH = "1";
		process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = BOGUS_EXTRA_DIRS;
		process.env.PI_SUBAGENT_PARENT_SESSION = "polluted-parent";
		process.env.PI_SUBAGENT_PI_BINARY = BOGUS_PI_BINARY;
		process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = BOGUS_PI_PACKAGE_ROOT;

		try {
			run = await runRealSubagentSession({
				prompt: "Delegate to a worker and report its exact result.",
				childText: CHILD_MARKER,
				respond: routeParentThroughSubagent({
					childMarker: CHILD_MARKER,
					subagentArgs: {
						agent: "worker",
						task: "Return the marker from the faux child provider.",
						context: "fresh",
						agentScope: "project",
					},
				}),
			});

			const toolResults = subagentToolResults(run.parentSession);
			assert.equal(toolResults.length, 1);
			assert.match(toolResults[0]!, new RegExp(CHILD_MARKER));
			assert.match(run.responseText, new RegExp(CHILD_MARKER));
			assert.doesNotMatch(run.responseText, /CHILD_MISSING/);
			assert.ok(run.modelCalls >= 2, `expected parent tool-call and final turns, got ${run.modelCalls}`);
		} finally {
			await run?.dispose();
			run = undefined;
			for (const [key, value] of previousEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("delivers foreground steer and action responses with artifact-off live transcript", async () => {
		const { routeParentThroughSubagent, runRealSubagentSession, subagentToolResults } = await import("../support/real-session-runner.ts");
		const existingRuns = new Set(fs.existsSync(FOREGROUND_RUNS_DIR) ? fs.readdirSync(FOREGROUND_RUNS_DIR) : []);
		let exercisedRunId = "";
		let transcriptPath = "";
		let releaseTranscript = () => {};
		const waitFor = async <T>(read: () => T | undefined, label: string, timeoutMs = 10_000): Promise<T> => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const value = read();
				if (value !== undefined) return value;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			throw new Error(`Timed out waiting for ${label}`);
		};

		try {
			run = await runRealSubagentSession({
				prompt: "Delegate to a worker, keep it responsive to steering, and report its exact result.",
				childText: INTERACTIVE_MARKER,
				interactiveChildControl: true,
				timeoutMs: 30_000,
				respond: routeParentThroughSubagent({
					childMarker: INTERACTIVE_MARKER,
					subagentArgs: {
						agent: "worker",
						task: "Work until the parent steering arrives, then return the faux provider marker.",
						context: "fresh",
						agentScope: "project",
						artifacts: false,
					},
				}),
				duringPrompt: async () => {
					exercisedRunId = await waitFor(() => {
						if (!fs.existsSync(FOREGROUND_RUNS_DIR)) return undefined;
						return fs.readdirSync(FOREGROUND_RUNS_DIR).find((candidate) => !existingRuns.has(candidate));
					}, "foreground control root");
					transcriptPath = liveTranscriptPath(exercisedRunId, 0);
					await waitFor(() => fs.existsSync(transcriptPath) ? true : undefined, "artifact-off live transcript");
					releaseTranscript = retainLiveTranscript(transcriptPath, { id: () => "e2e-view" });

					const actionDir = actionTargetDir(foregroundControlRoot(exercisedRunId), 0);
					const action = requestControlAction(actionDir, "cycleThinking", { source: "e2e" }, {
						id: () => "e2e-cycle-thinking",
						now: () => Date.now(),
					});
					const steerId = "e2e-foreground-steer";
					writeSteerRequestToDir(foregroundSteerInboxDir(exercisedRunId, 0), {
						type: "steer", id: steerId, ts: Date.now(), message: "Return the interactive control marker now.", source: "e2e",
					});

					const response = await waitFor(() => consumeControlActionResponses(actionDir)
						.find((candidate) => candidate.requestId === action.id), "cycleThinking action response");
					assert.equal(response.status, "applied");
					assert.equal(typeof (response.result as { thinkingLevel?: unknown } | undefined)?.thinkingLevel, "string");
					await waitFor(() => {
						const transcript = fs.readFileSync(transcriptPath, "utf-8");
						return transcript.includes("FIRST_FINALIZED_EVENT")
							&& transcript.includes(steerDeliveryMarker(steerId))
							&& transcript.includes(INTERACTIVE_MARKER) ? true : undefined;
					}, "finalized foreground steer transcript");
				},
			});

			assert.ok(exercisedRunId);
			assert.equal(transcriptPath, liveTranscriptPath(exercisedRunId, 0));
			assert.equal(fs.existsSync(transcriptPath), true, "the simulated view lease retains the terminal runtime transcript");
			const toolResults = subagentToolResults(run.parentSession);
			assert.equal(toolResults.length, 1);
			assert.match(toolResults[0]!, new RegExp(INTERACTIVE_MARKER));
			assert.doesNotMatch(toolResults[0]!, /STEER_MISSING/);
		} finally {
			releaseTranscript();
			await run?.dispose();
			run = undefined;
		}
		assert.equal(fs.existsSync(transcriptPath), false, "runtime transcript is removed after the view lease releases");
	});
});
