import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR, type NestedRunSummary } from "../../../shared/types.ts";
import {
	MAX_DEPTH,
	ROUTE_FILE,
	assertSafeId,
	clampNumber,
	commonRouteRoot,
	containedPath,
	validateRouteShape,
} from "./core.ts";
import { NESTED_EVENTS_DIR, type NestedRoute } from "./types.ts";
import { isSafeNestedId } from "./validation.ts";
import { parseNestedPathEnv, type NestedPathEntry } from "../nested-path.ts";
import {
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../pi-args.ts";

export function createNestedRoute(rootRunId: string): NestedRoute {
	assertSafeId("rootRunId", rootRunId);
	const capabilityToken = randomUUID();
	const routeRoot = path.join(NESTED_EVENTS_DIR, `${rootRunId}-${capabilityToken}`);
	const eventSink = path.join(routeRoot, "events");
	const controlInbox = path.join(routeRoot, "controls");
	fs.mkdirSync(eventSink, { recursive: true, mode: 0o700 });
	fs.mkdirSync(controlInbox, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(routeRoot, ROUTE_FILE), `${JSON.stringify({ rootRunId, capabilityToken, createdAt: Date.now() })}\n`, { mode: 0o600 });
	return { rootRunId, eventSink, controlInbox, capabilityToken };
}

export function resolveNestedRouteFromEnv(env: NodeJS.ProcessEnv = process.env): NestedRoute | undefined {
	const rootRunId = env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV];
	const eventSink = env[SUBAGENT_PARENT_EVENT_SINK_ENV];
	const controlInbox = env[SUBAGENT_PARENT_CONTROL_INBOX_ENV];
	const capabilityToken = env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV];
	if (!rootRunId || !eventSink || !controlInbox || !capabilityToken) return undefined;
	const route = { rootRunId, eventSink, controlInbox, capabilityToken };
	validateRouteShape(route);
	const routeFile = path.join(commonRouteRoot(route), ROUTE_FILE);
	const metadata = JSON.parse(fs.readFileSync(routeFile, "utf-8")) as { rootRunId?: unknown; capabilityToken?: unknown };
	if (metadata.rootRunId !== rootRunId || metadata.capabilityToken !== capabilityToken) {
		throw new Error("Nested event route metadata does not match the provided root id and capability token.");
	}
	return route;
}

export function resolveInheritedNestedRouteFromEnv(env: NodeJS.ProcessEnv = process.env): NestedRoute | undefined {
	try {
		return resolveNestedRouteFromEnv(env);
	} catch (error) {
		console.error("Ignoring invalid nested subagent event route:", error);
		return undefined;
	}
}

export function resolveNestedParentAddressFromEnv(env: NodeJS.ProcessEnv = process.env): { parentRunId: string; parentStepIndex?: number; depth: number; path: NestedPathEntry[] } | undefined {
	const parentRunId = env[SUBAGENT_PARENT_RUN_ID_ENV];
	if (!isSafeNestedId(parentRunId)) return undefined;
	const rawIndex = env[SUBAGENT_PARENT_CHILD_INDEX_ENV];
	const parentStepIndex = rawIndex && /^\d+$/.test(rawIndex) ? Number(rawIndex) : undefined;
	const depth = Math.min(Math.max(1, clampNumber(Number(env[SUBAGENT_PARENT_DEPTH_ENV])) ?? 1), MAX_DEPTH);
	const parsedPath = parseNestedPathEnv(env[SUBAGENT_PARENT_PATH_ENV]);
	const nestedPath = parsedPath.length ? parsedPath : [{ runId: parentRunId, ...(parentStepIndex !== undefined ? { stepIndex: parentStepIndex } : {}) }];
	return { parentRunId, ...(parentStepIndex !== undefined ? { parentStepIndex } : {}), depth, path: nestedPath };
}

export function resolveNestedAsyncDir(rootRunId: string, run: NestedRunSummary): string | undefined {
	if (!run.asyncDir) return undefined;
	const resolved = path.resolve(run.asyncDir);
	const nestedRoot = path.resolve(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId, run.id);
	const relative = path.relative(nestedRoot, resolved);
	return resolved === nestedRoot || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved : undefined;
}

export function findNestedRouteForRootId(rootRunId: string): NestedRoute | undefined {
	assertSafeId("rootRunId", rootRunId);
	let entries: string[];
	try {
		entries = fs.readdirSync(NESTED_EVENTS_DIR);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.startsWith(`${rootRunId}-`)) continue;
		const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
		try {
			const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf-8")) as { rootRunId?: unknown; capabilityToken?: unknown };
			if (metadata.rootRunId !== rootRunId || typeof metadata.capabilityToken !== "string") continue;
			const route = {
				rootRunId,
				eventSink: path.join(routeRoot, "events"),
				controlInbox: path.join(routeRoot, "controls"),
				capabilityToken: metadata.capabilityToken,
			};
			validateRouteShape(route);
			return route;
		} catch {
			continue;
		}
	}
	return undefined;
}

/**
 * Scan the nested-events directory once and index every route by its root run
 * id. Use this when resolving routes for many runs (e.g. listAsyncRuns) so the
 * cost is O(routes) total instead of O(runs * routes) from calling
 * findNestedRouteForRootId per run.
 */
export function buildNestedRouteIndex(): Map<string, NestedRoute> {
	let entries: string[];
	try {
		entries = fs.readdirSync(NESTED_EVENTS_DIR);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
		throw error;
	}
	const index = new Map<string, NestedRoute>();
	for (const entry of entries) {
		const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
		try {
			const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf-8")) as { rootRunId?: unknown; capabilityToken?: unknown };
			if (typeof metadata.rootRunId !== "string" || typeof metadata.capabilityToken !== "string") continue;
			if (index.has(metadata.rootRunId)) continue;
			const route: NestedRoute = {
				rootRunId: metadata.rootRunId,
				eventSink: path.join(routeRoot, "events"),
				controlInbox: path.join(routeRoot, "controls"),
				capabilityToken: metadata.capabilityToken,
			};
			validateRouteShape(route);
			index.set(metadata.rootRunId, route);
		} catch {
			continue;
		}
	}
	return index;
}

export function nestedRouteEnv(route: NestedRoute): Record<string, string> {
	return {
		[SUBAGENT_PARENT_EVENT_SINK_ENV]: route.eventSink,
		[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: route.controlInbox,
		[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: route.rootRunId,
		[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: route.capabilityToken,
	};
}

export function nestedArtifactEnv(rootRunId: string, parentRunId: string): Record<string, string> {
	return {
		PI_SUBAGENT_NESTED_ROOT_RUN_ID: rootRunId,
		PI_SUBAGENT_NESTED_PARENT_RUN_ID: parentRunId,
	};
}

export function isTopLevelAsyncDir(asyncDir: string): boolean {
	const resolved = path.resolve(asyncDir);
	return containedPath(ASYNC_DIR, resolved) && !containedPath(path.join(TEMP_ROOT_DIR, "nested-subagent-runs"), resolved);
}

export function nestedResultsPath(rootRunId: string, id: string): string {
	assertSafeId("rootRunId", rootRunId);
	assertSafeId("id", id);
	return path.join(RESULTS_DIR, "nested", rootRunId, `${id}.json`);
}
