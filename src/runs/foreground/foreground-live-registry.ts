import type { ForegroundLiveChild } from "../../shared/types.ts";
import { foregroundRunDir } from "../shared/control-actions/paths.ts";

export interface ForegroundLiveRegistryFs {
	rmSync(path: string, options: { recursive: true; force: true }): void;
}

export function foregroundLiveChildKey(runId: string, index: number): string {
	return `${runId}:${index}`;
}

export function registerForegroundLiveChild(
	registry: Map<string, ForegroundLiveChild>,
	child: ForegroundLiveChild,
): void {
	registry.set(foregroundLiveChildKey(child.runId, child.index), child);
}

export function removeForegroundLiveChild(
	registry: Map<string, ForegroundLiveChild>,
	runId: string,
	index: number,
	status: "completed" | "failed",
	fs: ForegroundLiveRegistryFs,
	now: () => number = Date.now,
): void {
	const key = foregroundLiveChildKey(runId, index);
	const child = registry.get(key);
	if (child) {
		child.status = status;
		child.updatedAt = now();
		registry.delete(key);
	}
	if ([...registry.values()].some((candidate) => candidate.runId === runId)) return;
	try {
		fs.rmSync(foregroundRunDir(runId), { recursive: true, force: true });
	} catch {
		// The in-memory registry is authoritative; runtime directory cleanup is best effort.
	}
}

export function cleanupForegroundLiveChildren(
	registry: Map<string, ForegroundLiveChild>,
	fs: ForegroundLiveRegistryFs,
): void {
	const runIds = new Set([...registry.values()].map((child) => child.runId));
	registry.clear();
	for (const runId of runIds) {
		try {
			fs.rmSync(foregroundRunDir(runId), { recursive: true, force: true });
		} catch {
			// Session lifecycle cleanup must continue when a stale root cannot be removed.
		}
	}
}

export function cleanupForegroundRunRoot(
	registry: Map<string, ForegroundLiveChild>,
	runId: string,
	fs: ForegroundLiveRegistryFs,
): void {
	if ([...registry.values()].some((child) => child.runId === runId)) return;
	try {
		fs.rmSync(foregroundRunDir(runId), { recursive: true, force: true });
	} catch {
		// The registry is authoritative; runtime directory cleanup is best effort.
	}
}
