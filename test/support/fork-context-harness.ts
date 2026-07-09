/**
 * Shared harness for the fork-context integration test siblings.
 *
 * Holds module-level tryImport consts, shared types, and the top-level helper
 * functions extracted from the original `fork-context-execution.test.ts`.
 */
import { tryImport } from "./helpers.ts";

export interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: unknown,
		) => Promise<{
			isError?: boolean;
			content: Array<{ text?: string }>;
			details?: {
				context?: "fresh" | "fork";
				mode?: "single" | "parallel" | "chain";
				asyncId?: string;
				results?: Array<{ detached?: boolean; exitCode?: number; skills?: string[] }>;
			};
		}>;
	};
}

export interface AsyncExecutionModule {
	isAsyncAvailable?: () => boolean;
}

export interface ProgressUpdate {
	details?: {
		progress?: Array<{ status?: string; currentTool?: string }>;
	};
}

export const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
export const asyncExecutionMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
export const available = !!executorMod;
export const createSubagentExecutor = executorMod?.createSubagentExecutor;
export const asyncAvailable = asyncExecutionMod?.isAsyncAvailable?.() === true;
export const originalHome = process.env.HOME;
export const originalUserProfile = process.env.USERPROFILE;

export interface SessionStubOptions {
	sessionFile?: string;
	leafId?: string | null;
}

export interface SessionManagerStub {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	openSession(sessionFile: string): { createBranchedSession(leafId: string): string | undefined };
}

export function makeSessionManagerRecorder(options: SessionStubOptions = {}) {
	const manager: SessionManagerStub = {
		getSessionId: () => "session-123",
		getSessionFile: () => options.sessionFile,
		getLeafId: () => (options.leafId === undefined ? "leaf-current" : options.leafId),
		openSession: () => ({
			createBranchedSession: () => "/tmp/child.jsonl",
		}),
	};
	return { manager };
}

export function makeState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

