import * as fs from "node:fs";
import type { NestedRunSummary } from "../../../shared/types.ts";
import { sanitizeSummary } from "../../shared/nested-events.ts";

export const WATCHER_RESTART_DELAY_MS = 3000;
export const POLL_INTERVAL_MS = 3000;

export type ResultWatcherFs = Pick<typeof fs, "existsSync" | "readFileSync" | "unlinkSync" | "readdirSync" | "mkdirSync" | "realpathSync" | "watch">;

export type ResultWatcherTimers = {
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
	setInterval: typeof setInterval;
	clearInterval: typeof clearInterval;
};

export type ResultWatcherDeps = {
	fs?: ResultWatcherFs;
	timers?: ResultWatcherTimers;
};

export type ResultFileChild = {
	agent?: string;
	output?: string;
	error?: string;
	success?: boolean;
	sessionFile?: string;
	artifactPaths?: { outputPath?: string };
	intercomTarget?: string;
	children?: unknown;
};

export type ResultFileData = {
	id?: string;
	runId?: string;
	agent?: string;
	success?: boolean;
	state?: string;
	mode?: string;
	summary?: string;
	results?: ResultFileChild[];
	nestedChildren?: unknown;
	sessionId?: string;
	cwd?: string;
	sessionFile?: string;
	asyncDir?: string;
	intercomTarget?: string;
};

export function sanitizeNestedResultChildren(value: unknown, resultPath: string, label: string): NestedRunSummary[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		console.error(`Ignoring invalid nested children in subagent result file '${resultPath}' at ${label}: expected an array.`);
		return undefined;
	}
	const children = value.map((child) => sanitizeSummary(child)).filter((child): child is NestedRunSummary => Boolean(child));
	if (children.length !== value.length) {
		console.error(`Ignoring ${value.length - children.length} invalid nested child record(s) in subagent result file '${resultPath}' at ${label}.`);
	}
	return children.length ? children : undefined;
}

export function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}

export function isNotFoundError(error: unknown): boolean {
	return getErrorCode(error) === "ENOENT";
}

export function shouldFallBackToPolling(error: unknown): boolean {
	const code = getErrorCode(error);
	return code === "EMFILE" || code === "ENOSPC";
}

export function resolveNativeWatchDir(fsApi: ResultWatcherFs, resultsDir: string): string {
	try {
		return fsApi.realpathSync.native(resultsDir);
	} catch {
		return resultsDir;
	}
}
