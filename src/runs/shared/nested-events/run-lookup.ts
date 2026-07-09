import * as fs from "node:fs";
import * as path from "node:path";
import type { NestedRunSummary } from "../../../shared/types.ts";
import { ROUTE_FILE, assertSafeId, validateRouteShape } from "./core.ts";
import { NESTED_EVENTS_DIR, type NestedRoute, type NestedRunMatch, type NestedRunResolutionScope } from "./types.ts";
import { projectNestedEvents } from "./projection.ts";

export function findNestedRun(children: NestedRunSummary[] | undefined, id: string): NestedRunSummary | undefined {
	if (!children?.length) return undefined;
	for (const child of children) {
		if (child.id === id) return child;
		const nested = findNestedRun(child.children, id) ?? findNestedRun(child.steps?.flatMap((step) => step.children ?? []), id);
		if (nested) return nested;
	}
	return undefined;
}

function listNestedRoutes(): NestedRoute[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(NESTED_EVENTS_DIR);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const routes: NestedRoute[] = [];
	for (const entry of entries) {
		const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
		try {
			const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf-8")) as { rootRunId?: unknown; capabilityToken?: unknown };
			if (typeof metadata.rootRunId !== "string" || typeof metadata.capabilityToken !== "string") continue;
			const route = {
				rootRunId: metadata.rootRunId,
				eventSink: path.join(routeRoot, "events"),
				controlInbox: path.join(routeRoot, "controls"),
				capabilityToken: metadata.capabilityToken,
			};
			validateRouteShape(route);
			routes.push(route);
		} catch {
			continue;
		}
	}
	return routes;
}

function collectNestedRuns(children: NestedRunSummary[] | undefined, output: NestedRunSummary[] = []): NestedRunSummary[] {
	for (const child of children ?? []) {
		output.push(child);
		collectNestedRuns(child.children, output);
		collectNestedRuns(child.steps?.flatMap((step) => step.children ?? []), output);
	}
	return output;
}

function collectScopedNestedRuns(children: NestedRunSummary[] | undefined, scope: NestedRunResolutionScope["descendantOf"], output: NestedRunSummary[] = []): NestedRunSummary[] {
	if (!scope) return collectNestedRuns(children, output);
	for (const child of children ?? []) {
		if (child.parentRunId === scope.parentRunId && (scope.parentStepIndex === undefined || child.parentStepIndex === scope.parentStepIndex)) {
			collectNestedRuns([child], output);
			continue;
		}
		collectScopedNestedRuns(child.children, scope, output);
		collectScopedNestedRuns(child.steps?.flatMap((step) => step.children ?? []), scope, output);
	}
	return output;
}

export function findNestedRunMatchesById(id: string, options: { prefix?: boolean; scope?: NestedRunResolutionScope } = {}): NestedRunMatch[] {
	assertSafeId("id", id);
	const matches: NestedRunMatch[] = [];
	for (const route of options.scope?.routes ?? listNestedRoutes()) {
		try {
			const registry = projectNestedEvents(route);
			for (const run of collectScopedNestedRuns(registry.children, options.scope?.descendantOf)) {
				if (options.prefix ? run.id.startsWith(id) : run.id === id) matches.push({ rootRunId: route.rootRunId, route, run });
			}
		} catch {
			continue;
		}
	}
	return matches;
}

export function findNestedRunById(id: string): { rootRunId: string; run: NestedRunSummary } | undefined {
	const match = findNestedRunMatchesById(id)[0];
	return match ? { rootRunId: match.rootRunId, run: match.run } : undefined;
}
