import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../../shared/atomic-json.ts";
import type { NestedRunSummary } from "../../../shared/types.ts";
import { MAX_CHILDREN, MAX_EVENT_BYTES, REGISTRY_FILE, commonRouteRoot, containedPath, terminal, validateRouteShape } from "./core.ts";
import type { NestedEventRecord, NestedRegistry, NestedRoute } from "./types.ts";
import { sanitizeSummary } from "./sanitize.ts";
import { parseNestedEventRecords } from "./event-records.ts";
import { findNestedRouteForRootId } from "./route.ts";

function mergeSummary(existing: NestedRunSummary | undefined, event: NestedEventRecord): NestedRunSummary {
	const incomingState = event.type === "subagent.nested.completed" && event.child.state === "running" ? "complete" : event.child.state;
	const incoming = { ...event.child, state: incomingState, lastUpdate: event.child.lastUpdate ?? event.ts };
	if (!existing) return incoming;
	const existingUpdate = existing.lastUpdate ?? 0;
	const incomingUpdate = incoming.lastUpdate ?? event.ts;
	if (incomingUpdate < existingUpdate) return existing;
	if (terminal(existing.state) && !terminal(incoming.state)) return existing;
	if (terminal(existing.state) && terminal(incoming.state) && incomingUpdate === existingUpdate) return existing;
	return { ...existing, ...incoming, state: incoming.state, lastUpdate: Math.max(existingUpdate, incomingUpdate) };
}

function attachChild(children: NestedRunSummary[], event: NestedEventRecord): NestedRunSummary[] {
	let updated = false;
	const walk = (items: NestedRunSummary[]): NestedRunSummary[] => items.map((item) => {
		if (item.id === event.parentRunId) {
			const existingChildren = item.children ?? [];
			const childIndex = existingChildren.findIndex((child) => child.id === event.child.id);
			const nextChild = mergeSummary(childIndex >= 0 ? existingChildren[childIndex] : undefined, event);
			const nextChildren = childIndex >= 0
				? existingChildren.map((child, index) => index === childIndex ? nextChild : child)
				: [...existingChildren, nextChild];
			updated = true;
			return { ...item, children: nextChildren.slice(0, MAX_CHILDREN), lastUpdate: Math.max(item.lastUpdate ?? 0, event.ts) };
		}
		if (!item.children?.length) return item;
		const nextChildren = walk(item.children);
		return nextChildren === item.children ? item : { ...item, children: nextChildren };
	});
	const next = walk(children);
	if (updated) return next;
	const childIndex = next.findIndex((child) => child.id === event.child.id);
	const nextChild = mergeSummary(childIndex >= 0 ? next[childIndex] : undefined, event);
	return childIndex >= 0
		? next.map((child, index) => index === childIndex ? nextChild : child)
		: [...next, nextChild].slice(0, MAX_CHILDREN);
}

export function applyNestedEvent(registry: NestedRegistry, event: NestedEventRecord): NestedRegistry {
	return {
		...registry,
		updatedAt: Math.max(registry.updatedAt, event.ts),
		children: attachChild(registry.children, event),
	};
}

function registryPath(route: NestedRoute): string {
	return path.join(commonRouteRoot(route), REGISTRY_FILE);
}

export function readNestedRegistry(route: NestedRoute): NestedRegistry {
	validateRouteShape(route);
	try {
		const parsed = JSON.parse(fs.readFileSync(registryPath(route), "utf-8")) as NestedRegistry;
		return {
			rootRunId: route.rootRunId,
			updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
			children: Array.isArray(parsed.children) ? parsed.children.map((child) => sanitizeSummary(child)).filter((child): child is NestedRunSummary => Boolean(child)) : [],
			processedEvents: Array.isArray(parsed.processedEvents) ? parsed.processedEvents.filter((item): item is string => typeof item === "string") : [],
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { rootRunId: route.rootRunId, updatedAt: 0, children: [], processedEvents: [] };
	}
}

export function projectNestedEvents(route: NestedRoute): NestedRegistry {
	validateRouteShape(route);
	let registry = readNestedRegistry(route);
	const seen = new Set(registry.processedEvents);
	let changed = false;
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(route.eventSink).filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const entry of entries) {
		if (seen.has(entry)) continue;
		const eventPath = path.join(route.eventSink, entry);
		if (!containedPath(route.eventSink, eventPath)) continue;
		let content: string;
		try {
			const stat = fs.statSync(eventPath);
			if (!stat.isFile() || stat.size > MAX_EVENT_BYTES) continue;
			content = fs.readFileSync(eventPath, "utf-8");
		} catch {
			continue;
		}
		for (const event of parseNestedEventRecords(content, route)) {
			registry = applyNestedEvent(registry, event);
			changed = true;
		}
		seen.add(entry);
		changed = true;
	}
	if (changed) {
		registry = { ...registry, processedEvents: [...seen].slice(-1000) };
		// Parent projection is the only writer to this sidecar registry. Child and
		// runner processes only create immutable event files, so parent status.json
		// remains owned by the existing runner writer and is never rewritten here.
		writeAtomicJson(registryPath(route), registry);
	}
	return registry;
}

export function projectNestedRegistryForRoot(rootRunId: string): NestedRegistry | undefined {
	const route = findNestedRouteForRootId(rootRunId);
	return route ? projectNestedEvents(route) : undefined;
}
