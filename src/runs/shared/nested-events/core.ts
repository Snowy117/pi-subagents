import * as path from "node:path";
import { NESTED_EVENTS_DIR, type NestedRoute } from "./types.ts";
import { assertSafeNestedId } from "./validation.ts";
import type { NestedRunState } from "../../../shared/types.ts";

export const ROUTE_FILE = "route.json";
export const REGISTRY_FILE = "registry.json";
export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_STEPS = 12;
export const MAX_CHILDREN = 16;
export const MAX_DEPTH = 3;

export function clampNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringValue(value: unknown, max = 512): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

export function containedPath(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

export function commonRouteRoot(route: Pick<NestedRoute, "eventSink" | "controlInbox">): string {
	return path.dirname(path.resolve(route.eventSink));
}

export function assertSafeId(label: string, value: string): void {
	assertSafeNestedId(label, value);
}

export function validateRouteShape(route: NestedRoute): void {
	assertSafeId("rootRunId", route.rootRunId);
	assertSafeId("capabilityToken", route.capabilityToken);
	if (!containedPath(NESTED_EVENTS_DIR, route.eventSink)) throw new Error("Nested event sink is outside the subagent nested event root.");
	if (!containedPath(NESTED_EVENTS_DIR, route.controlInbox)) throw new Error("Nested control inbox is outside the subagent nested event root.");
	if (commonRouteRoot(route) !== path.dirname(path.resolve(route.controlInbox))) throw new Error("Nested event sink and control inbox must share one route root.");
}

export function terminal(state: NestedRunState): boolean {
	return state === "complete" || state === "failed" || state === "paused";
}
