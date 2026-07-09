/**
 * Native supervisor channel — parent-side request discovery, lifecycle
 * classification, stale-channel cleanup, and pending-request refresh.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../../shared/types.ts";
import type {
	PendingSupervisorRequest,
	SupervisorRequest,
	SupervisorRequestLifecycle,
} from "./types.ts";
import {
	DEFAULT_ASK_TIMEOUT_MS,
	REQUESTS_DIR,
	REPLIES_DIR,
	STALE_EMPTY_CHANNEL_AGE_MS,
	SUPERVISOR_CHANNEL_ROOT,
} from "./types.ts";
import { removeRequestFile, replyPath } from "./channel-paths.ts";

export function parseRequestFile(file: string, channelDir: string): PendingSupervisorRequest | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SupervisorRequest>;
		if (parsed.type !== "subagent.supervisor.request") return undefined;
		if (typeof parsed.id !== "string" || !parsed.id) return undefined;
		if (parsed.reason !== "need_decision" && parsed.reason !== "interview_request" && parsed.reason !== "progress_update") return undefined;
		if (typeof parsed.message !== "string" || !parsed.message) return undefined;
		if (typeof parsed.runId !== "string" || typeof parsed.agent !== "string" || typeof parsed.childIndex !== "number") return undefined;
		return { ...parsed as SupervisorRequest, channelDir, requestFile: file };
	} catch {
		return undefined;
	}
}

export function listRequestFiles(): Array<{ channelDir: string; file: string }> {
	let channelEntries: fs.Dirent[];
	try {
		channelEntries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const files: Array<{ channelDir: string; file: string }> = [];
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		const channelDir = path.join(SUPERVISOR_CHANNEL_ROOT, entry.name);
		const requestsDir = path.join(channelDir, REQUESTS_DIR);
		let requestEntries: fs.Dirent[];
		try {
			requestEntries = fs.readdirSync(requestsDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const requestEntry of requestEntries) {
			if (requestEntry.isFile() && requestEntry.name.endsWith(".json")) files.push({ channelDir, file: path.join(requestsDir, requestEntry.name) });
		}
	}
	return files;
}

function readDirectoryEntries(dir: string): fs.Dirent[] | undefined {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return undefined;
	}
}

function directoryMtimeMs(dir: string): number {
	try {
		return fs.statSync(dir).mtimeMs;
	} catch {
		return 0;
	}
}

function removeEmptyDirectory(dir: string): boolean {
	try {
		fs.rmdirSync(dir);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return true;
		if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "EBUSY") return false;
		throw error;
	}
}

function removeStaleEmptySupervisorChannel(channelDir: string, nowMs: number): boolean {
	const requestsDir = path.join(channelDir, REQUESTS_DIR);
	const repliesDir = path.join(channelDir, REPLIES_DIR);
	const newestKnownMtimeMs = Math.max(
		directoryMtimeMs(channelDir),
		directoryMtimeMs(requestsDir),
		directoryMtimeMs(repliesDir),
	);
	if (nowMs - newestKnownMtimeMs < STALE_EMPTY_CHANNEL_AGE_MS) return false;

	const requestEntries = readDirectoryEntries(requestsDir);
	if (!requestEntries || requestEntries.length > 0) return false;
	const replyEntries = readDirectoryEntries(repliesDir);
	if (!replyEntries || replyEntries.length > 0) return false;

	if (!removeEmptyDirectory(requestsDir)) return false;
	if (!removeEmptyDirectory(repliesDir)) return false;
	if (!removeEmptyDirectory(channelDir)) return false;
	return true;
}

export function cleanupStaleEmptySupervisorChannels(nowMs = Date.now()): number {
	let channelEntries: fs.Dirent[];
	try {
		channelEntries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}

	let removed = 0;
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		try {
			if (removeStaleEmptySupervisorChannel(path.join(SUPERVISOR_CHANNEL_ROOT, entry.name), nowMs)) removed++;
		} catch {
			// Cleanup is opportunistic; active writers can race with us and will be picked up by a later pass.
		}
	}
	return removed;
}

function currentContextSessionId(state: Pick<SubagentState, "currentSessionId">, ctx: ExtensionContext): string | undefined {
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId) return sessionId;
	} catch {
		// Fall through to the last known identity.
	}
	return state.currentSessionId ?? undefined;
}

export function requestMatchesContext(request: SupervisorRequest, state: Pick<SubagentState, "currentSessionId">, ctx: ExtensionContext): boolean {
	const currentSessionId = currentContextSessionId(state, ctx);
	return Boolean(currentSessionId && request.orchestratorSessionId === currentSessionId);
}

function requestExpiresAt(request: SupervisorRequest, now: number): number {
	const expiresAt = (request as { expiresAt?: unknown }).expiresAt;
	if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) return expiresAt;
	return Number.isFinite(request.createdAt) ? request.createdAt + DEFAULT_ASK_TIMEOUT_MS : now;
}

function requestRunInactive(request: SupervisorRequest, state: SubagentState): boolean {
	if (state.foregroundControls.has(request.runId)) return false;
	const foregroundRun = state.foregroundRuns?.get(request.runId);
	const foregroundChild = foregroundRun?.children.find((child) => child.index === request.childIndex && child.agent === request.agent)
		?? foregroundRun?.children[request.childIndex];
	if (foregroundChild) return foregroundChild.status !== "detached";

	const asyncJob = state.asyncJobs.get(request.runId);
	if (!asyncJob) return false;
	if (asyncJob.status === "complete" || asyncJob.status === "failed" || asyncJob.status === "paused") return true;
	const stepStatus = asyncJob.steps?.[request.childIndex]?.status;
	return stepStatus === "complete" || stepStatus === "completed" || stepStatus === "failed" || stepStatus === "paused";
}

export function requestLifecycle(request: PendingSupervisorRequest, state: SubagentState, ctx: ExtensionContext | undefined, now: number): SupervisorRequestLifecycle {
	if (ctx && !requestMatchesContext(request, state, ctx)) return "wrong-session";
	if (!fs.existsSync(request.requestFile)) return "missing";
	if (request.expectsReply && fs.existsSync(replyPath(request.channelDir, request.id))) return "resolved";
	if (request.expectsReply && now > requestExpiresAt(request, now)) return "expired";
	if (request.expectsReply && requestRunInactive(request, state)) return "inactive";
	return "pending";
}

export function cleanupRequestLifecycle(request: PendingSupervisorRequest, lifecycle: SupervisorRequestLifecycle): void {
	if (lifecycle === "resolved" || lifecycle === "expired" || lifecycle === "inactive") removeRequestFile(request.requestFile);
}

export function refreshPendingRequests(pending: Map<string, PendingSupervisorRequest>, state: SubagentState, ctx: ExtensionContext | undefined): void {
	const now = Date.now();
	for (const request of pending.values()) {
		const lifecycle = requestLifecycle(request, state, ctx, now);
		if (lifecycle === "pending") continue;
		pending.delete(request.id);
		cleanupRequestLifecycle(request, lifecycle);
	}
}
