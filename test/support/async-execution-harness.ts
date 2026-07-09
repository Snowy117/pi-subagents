/**
 * Shared harness for the async-execution integration test siblings.
 *
 * Holds the module-level imports (resolved via tryImport from the project
 * root), the shared type interfaces, and the pure helper functions that the
 * original `async-execution.test.ts` used. Extracted so each themed sibling
 * test file can import these without duplicating them.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tryImport } from "./helpers.ts";
import type { MockPi } from "./helpers.ts";
export { deliverInterruptRequest } from "../../src/runs/background/control-channel.ts";

export interface AsyncExecutionResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details: { asyncId?: string };
}

export interface AsyncResultPayload {
	lifecycleArtifactVersion?: number;
	success: boolean;
	state?: string;
	exitCode?: number;
	sessionId?: string;
	mode?: string;
	summary?: string;
	error?: string;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; exceededAtTurn?: number };
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	totalTokens?: { input: number; output: number; total: number };
	totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
	results: Array<{ output?: string; success?: boolean; error?: string; timedOut?: boolean; turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; exceededAtTurn?: number }; turnBudgetExceeded?: boolean; wrapUpRequested?: boolean; model?: string; attemptedModels?: string[]; modelAttempts?: Array<{ success?: boolean; error?: string }>; totalCost?: { inputTokens: number; outputTokens: number; costUsd: number }; structuredOutput?: unknown; intercomTarget?: string; acceptance?: { status?: string; childReport?: unknown } }>;
	outputs?: Record<string, { text?: string; structured?: unknown }>;
	workflowGraph?: { nodes?: Array<{ kind?: string; label?: string; phase?: string; status?: string; error?: string; outputName?: string; structured?: boolean; children?: Array<{ label?: string; outputName?: string; itemKey?: string; status?: string; error?: string }> }> };
}

export interface AsyncStatusPayload {
	lifecycleArtifactVersion?: number;
	sessionId?: string;
	activityState?: string;
	currentTool?: string;
	currentPath?: string;
	state?: string;
	error?: string;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; exceededAtTurn?: number };
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	totalTokens?: { total: number };
	totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
	parallelGroups?: Array<{ start: number; count: number; stepIndex: number }>;
	steps?: Array<{
		label?: string;
		phase?: string;
		outputName?: string;
		structured?: boolean;
		skills?: string[];
		activityState?: string;
		currentTool?: string;
		status?: string;
		exitCode?: number;
		timedOut?: boolean;
		error?: string;
		model?: string;
		thinking?: string;
		tokens?: { total: number };
		totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
		acceptance?: { status?: string };
		turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; exceededAtTurn?: number };
		turnBudgetExceeded?: boolean;
		wrapUpRequested?: boolean;
	}>;
}

export interface MockPiCallRecord {
	args?: string[];
	systemPrompts?: Array<{ mode?: string; path?: string; text?: string; error?: string }>;
}

export function mockAssistantMessage(text: string, stopReason: "stop" | "tool_use" = "stop") {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: stopReason === "tool_use"
				? [{ type: "text", text }, { type: "toolCall", name: "bash", arguments: { command: "echo test" } }]
				: [{ type: "text", text }],
			model: "mock/test-model",
			stopReason,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.001 },
			},
		},
	};
}

export interface AsyncExecutionModule {
	isAsyncAvailable(): boolean;
	executeAsyncSingle(id: string, params: Record<string, unknown>): AsyncExecutionResult;
	executeAsyncChain(id: string, params: Record<string, unknown>): AsyncExecutionResult;
}

export interface UtilsModule {
	readStatus(dir: string): { runId: string; state: string; mode: string } | null;
}

export interface TypesModule {
	ASYNC_DIR: string;
	RESULTS_DIR: string;
	TEMP_ROOT_DIR: string;
}

export interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean; details?: { asyncId?: string } }>;
	};
}

export const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
export const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
export const typesMod = await tryImport<TypesModule>("./src/shared/types.ts");
export const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
export const available = !!(asyncMod && utils && typesMod);

export const isAsyncAvailable = asyncMod?.isAsyncAvailable;
export const executeAsyncSingle = asyncMod?.executeAsyncSingle;
export const executeAsyncChain = asyncMod?.executeAsyncChain;
export const readStatus = utils?.readStatus;
export const ASYNC_DIR = typesMod?.ASYNC_DIR;
export const RESULTS_DIR = typesMod?.RESULTS_DIR;
export const TEMP_ROOT_DIR = typesMod?.TEMP_ROOT_DIR;
export const createSubagentExecutor = executorMod?.createSubagentExecutor;

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

export function createRepo(prefix: string): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.email", "tests@example.com"]);
	git(repoDir, ["config", "user.name", "Async Tests"]);
	fs.writeFileSync(path.join(repoDir, "input.md"), "input\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
}

export function writePackageSkill(packageRoot: string, skillName: string): void {
	const skillDir = path.join(packageRoot, "skills", skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
		"utf-8",
	);
}

export async function waitForAsyncResultFile(id: string, timeoutMs = 15_000): Promise<string> {
	const resultPath = path.join(RESULTS_DIR, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return resultPath;
}

export async function waitForMockPiCall(mockPi: MockPi, index: number, timeoutMs = 30_000): Promise<{ args: string[]; systemPrompts: NonNullable<MockPiCallRecord["systemPrompts"]> }> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(index);
		if (callFile) {
			const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
			assert.ok(Array.isArray(payload.args), "expected recorded args");
			return { args: payload.args, systemPrompts: payload.systemPrompts ?? [] };
		}
		if (Date.now() > deadline) assert.fail(`Timed out waiting for recorded mock pi call ${index}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

export async function waitForMockPiArgs(mockPi: MockPi, index: number, timeoutMs = 30_000): Promise<string[]> {
	return (await waitForMockPiCall(mockPi, index, timeoutMs)).args;
}

export function readLastMockPiArgs(mockPi: MockPi): string[] {
	const callFile = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(-1);
	assert.ok(callFile, "expected a recorded mock pi call");
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return payload.args;
}

export function readMockPiArgs(mockPi: MockPi, index: number): string[] {
	const callFile = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(index);
	assert.ok(callFile, `expected recorded call ${index}`);
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return payload.args;
}

export function readMockPiArgsMatching(mockPi: MockPi, text: string): string[] {
	const callFiles = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort();
	for (const callFile of callFiles) {
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		if (payload.args.join("\n").includes(text)) return payload.args;
	}
	assert.fail(`expected recorded call containing ${text}`);
}

