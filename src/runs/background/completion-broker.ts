import type { SubagentRunMode } from "../../shared/types.ts";

export interface SyncCompletionTask {
	agent: string;
	task: string;
}

export interface NormalizedAsyncCompletion {
	runId: string;
	sessionId: string;
	mode: SubagentRunMode;
	data: Record<string, unknown>;
	cachedAt: number;
}

export interface SyncCompletionOwnership {
	runId: string;
	sessionId: string;
	mode: SubagentRunMode;
	tasks: SyncCompletionTask[];
	claimedAt: number;
}

export interface CompletionBroker {
	claim(input: Omit<SyncCompletionOwnership, "claimedAt">): void;
	isOwned(runId: string, sessionId?: string): boolean;
	release(runId: string): void;
	cache(completion: Omit<NormalizedAsyncCompletion, "cachedAt">): NormalizedAsyncCompletion;
	get(runId: string): NormalizedAsyncCompletion | undefined;
	wait(runId: string, signal?: AbortSignal): Promise<NormalizedAsyncCompletion | undefined>;
	resetSession(sessionId: string | null): void;
	dispose(): void;
}

export function createCompletionBroker(options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}): CompletionBroker {
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
	const maxEntries = options.maxEntries ?? 128;
	const completed = new Map<string, NormalizedAsyncCompletion>();
	const owned = new Map<string, SyncCompletionOwnership>();
	const waiters = new Map<string, Set<(completion: NormalizedAsyncCompletion | undefined) => void>>();
	let disposed = false;

	const prune = () => {
		const threshold = now() - ttlMs;
		for (const [id, entry] of completed) if (entry.cachedAt < threshold) completed.delete(id);
		for (const [id, entry] of owned) if (entry.claimedAt < threshold) owned.delete(id);
		while (completed.size > maxEntries) completed.delete(completed.keys().next().value as string);
		while (owned.size > maxEntries) owned.delete(owned.keys().next().value as string);
	};

	return {
		claim(input) { prune(); owned.set(input.runId, { ...input, claimedAt: now() }); },
		isOwned(runId, sessionId) {
			prune();
			const entry = owned.get(runId);
			return Boolean(entry && (sessionId === undefined || entry.sessionId === sessionId));
		},
		release(runId) { owned.delete(runId); },
		cache(input) {
			prune();
			const entry = { ...input, cachedAt: now() };
			completed.set(input.runId, entry);
			for (const resolve of waiters.get(input.runId) ?? []) resolve(entry);
			waiters.delete(input.runId);
			return entry;
		},
		get(runId) { prune(); return completed.get(runId); },
		wait(runId, signal) {
			const cached = this.get(runId);
			if (cached || disposed || signal?.aborted) return Promise.resolve(cached);
			return new Promise((resolve) => {
				const done = (completion: NormalizedAsyncCompletion | undefined) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(completion);
				};
				const onAbort = () => {
					waiters.get(runId)?.delete(done);
					done(undefined);
				};
				const set = waiters.get(runId) ?? new Set();
				set.add(done); waiters.set(runId, set);
				signal?.addEventListener("abort", onAbort, { once: true });
				const afterSubscribe = completed.get(runId);
				if (afterSubscribe) { set.delete(done); done(afterSubscribe); }
			});
		},
		resetSession(sessionId) {
			for (const [id, entry] of completed) if (entry.sessionId !== sessionId) completed.delete(id);
			for (const [id, entry] of owned) if (entry.sessionId !== sessionId) owned.delete(id);
		},
		dispose() {
			disposed = true; completed.clear(); owned.clear();
			for (const set of waiters.values()) for (const resolve of set) resolve(undefined);
			waiters.clear();
		},
	};
}
