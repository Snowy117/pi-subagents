import * as fs from "node:fs";
import * as path from "node:path";
import { type AsyncParallelGroupStatus, type AsyncStatus, type SubagentRunMode } from "../../../shared/types.ts";

export type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

export interface StartedRunMetadata {
	runId: string;
	pid?: number;
	sessionId?: string;
	mode?: SubagentRunMode;
	agents?: string[];
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	startedAt?: number;
	sessionFile?: string;
}

export interface ReconcileAsyncRunOptions {
	resultsDir?: string;
	kill?: KillFn;
	now?: () => number;
	startedRun?: StartedRunMetadata;
	missingStatusGraceMs?: number;
	staleAlivePidMs?: number;
}

export interface ReconcileAsyncRunResult {
	status: AsyncStatus | null;
	repaired: boolean;
	resultPath?: string;
	message?: string;
}

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function readRunnerStartupDiagnostics(asyncDir: string): string | undefined {
	const stderrPath = path.join(asyncDir, "runner.stderr.log");
	const maxBytes = 64 * 1024;
	let content: string;
	try {
		const stat = fs.statSync(stderrPath);
		if (stat.size <= 0) return undefined;
		const fd = fs.openSync(stderrPath, "r");
		try {
			const bytesToRead = Math.min(stat.size, maxBytes);
			const start = Math.max(0, stat.size - bytesToRead);
			const buffer = Buffer.alloc(bytesToRead);
			fs.readSync(fd, buffer, 0, bytesToRead, start);
			content = buffer.toString("utf-8").trim();
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	if (!content) return undefined;
	const lines = content.split(/\r?\n/).slice(-30).join("\n");
	return lines.length > 4000 ? `${lines.slice(-4000)}\n[stderr tail truncated]` : lines;
}

export function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function appendJsonlBestEffort(filePath: string, payload: object): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
	} catch {
		// Repair status/result writes are the important path. A broken or full
		// diagnostic event log must not make stale-run reconciliation fail.
	}
}

export function readStatusFile(asyncDir: string): AsyncStatus | null {
	const statusPath = path.join(asyncDir, "status.json");
	let content: string;
	try {
		content = fs.readFileSync(statusPath, "utf-8");
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw new Error(`Failed to read async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return JSON.parse(content) as AsyncStatus;
	} catch (error) {
		throw new Error(`Failed to parse async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

export interface ResultChildOutcome {
	agent?: string;
	success?: boolean;
	error?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	attemptedModels?: string[];
	modelAttempts?: NonNullable<AsyncStatus["steps"]>[number]["modelAttempts"];
}

export interface ResultRepairData {
	state: "complete" | "failed" | "paused";
	results?: ResultChildOutcome[];
}

export function readResultRepairData(resultPath: string): ResultRepairData | undefined {
	try {
		const data = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { success?: boolean; state?: string; exitCode?: number; results?: unknown };
		const state = data.success ? "complete" : data.state === "paused" || data.exitCode === 0 ? "paused" : "failed";
		const results = Array.isArray(data.results)
			? data.results.map((entry, index) => {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
				const child = entry as ResultChildOutcome;
				if (child.model !== undefined && typeof child.model !== "string") throw new Error(`Invalid async result file '${resultPath}': results[${index}].model must be a string.`);
				if (child.thinking !== undefined && typeof child.thinking !== "string") throw new Error(`Invalid async result file '${resultPath}': results[${index}].thinking must be a string.`);
				return child;
			})
			: undefined;
		return { state, ...(results ? { results } : {}) };
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}
