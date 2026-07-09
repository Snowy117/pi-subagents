/**
 * Shared harness for the single-execution integration test siblings.
 *
 * Holds module-level tryImport consts, shared type interfaces, and the pure
 * helper functions extracted from the original `single-execution.test.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { tryImport } from "./helpers.ts";


export interface ModelAttempt {
	success?: boolean;
	exitCode?: number;
	error?: string;
}

export interface ProgressSummary {
	agent: string;
	index: number;
	status: string;
	activityState?: string;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	tokens?: number;
	durationMs: number;
	toolCount: number;
}

export interface ArtifactPaths {
	outputPath: string;
	transcriptPath?: string;
	metadataPath?: string;
}

export interface RunSyncResult {
	exitCode: number;
	agent: string;
	messages: unknown[];
	error?: string;
	model?: string;
	skills?: string[];
	skillsWarning?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	usage: { turns: number; input: number; output: number };
	progress: ProgressSummary;
	controlEvents?: Array<{ type?: string; message: string; reason?: string; turns?: number; tokens?: number; currentPath?: string; recentFailureSummary?: string }>;
	artifactPaths?: ArtifactPaths;
	transcriptPath?: string;
	transcriptError?: string;
	finalOutput?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; exceededAtTurn?: number };
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	detached?: boolean;
	detachedReason?: string;
	savedOutputPath?: string;
	outputMode?: "inline" | "file-only";
	outputReference?: { path: string; bytes: number; lines: number; message: string };
	outputSaveError?: string;
	sessionFile?: string;
	acceptance?: {
		status?: string;
		verifyRuns?: Array<{ status?: string }>;
		runtimeChecks?: Array<{ id?: string; status?: string; message?: string }>;
	};
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

export interface ExecutionModule {
	runSync(
		runtimeCwd: string,
		agents: ReturnType<typeof makeAgentConfigs>,
		agentName: string,
		task: string,
		options: Record<string, unknown>,
	): Promise<RunSyncResult>;
}

export interface UtilsModule {
	getFinalOutput(messages: unknown[]): string;
}

export interface ExecutorToolResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details?: {
		totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
		timeoutMs?: number;
	};
}

export interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<ExecutorToolResult>;
	};
}

export const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
export const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
export const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
export const available = !!(execution && utils);

export const runSync = execution?.runSync;
export const getFinalOutput = utils?.getFinalOutput;
export const createSubagentExecutor = executorMod?.createSubagentExecutor;

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

