import type { RpcChildRegistry } from "../../../persistent/rpc-child-registry.ts";
import type { ConversationRelayHook } from "./types.ts";
import type { RelayWriterDeps } from "./relay-writer.ts";
import { createRelayWriter } from "./relay-writer.ts";
import type { RequestsWatcherDeps } from "./requests-watcher.ts";
import { createConversationRequestsWatcher, type ConversationRequestsWatcher } from "./requests-watcher.ts";
import { isConversing, clearBridgeHeartbeats } from "./heartbeat.ts";
import { ensureConversationDir, resolveConversationStepKey } from "./paths.ts";

/** Mirror of the parent extension's eviction cadence. */
export const CONVERSATION_EVICTION_INTERVAL_MS = 60_000;
/** Max time the runner lingers after finalize while a child is conversed. */
export const DEFAULT_MAX_LINGER_MS = 10 * 60_000;
export const DEFAULT_LINGER_TICK_MS = 2000;

export interface RunnerConversationBridgeDeps {
	relay?: RelayWriterDeps;
	watcher?: RequestsWatcherDeps;
	heartbeatTtlMs?: number;
}

/** Owns the per-step relays + request watchers and heartbeat-driven linger. */
export interface RunnerConversationBridge {
	/** Create (idempotent) the relay/watcher pair for one child step. */
	relayFor(agent: string, stepIndex: number, registryKey: string): ConversationRelayHook;
	conversingKeys(now?: number): Set<string>;
	conversingRegistryKeys(now?: number): string[];
	stopAll(): void;
	clearHeartbeats(): void;
}

export function createRunnerConversationBridge(options: {
	asyncDir: string;
	registry: RpcChildRegistry;
	deps?: RunnerConversationBridgeDeps;
}): RunnerConversationBridge {
	const { asyncDir, registry } = options;
	const deps = options.deps ?? {};
	// `dir` is the conversation subdir used for all bridge file paths;
	// isConversing/clearBridgeHeartbeats take the asyncDir and re-derive it,
	// so the original asyncDir must be kept for those calls.
	const dir = ensureConversationDir(asyncDir);
	const hooks = new Map<string, ConversationRelayHook>();
	const watchers = new Map<string, ConversationRequestsWatcher>();
	const registryKeys = new Map<string, string>();

	const currentConversingKeys = (now: number = Date.now()): Set<string> => {
		const keys = new Set<string>();
		for (const stepKey of hooks.keys()) {
			if (isConversing(asyncDir, stepKey, now, deps.heartbeatTtlMs)) keys.add(stepKey);
		}
		return keys;
	};

	return {
		relayFor(agent, stepIndex, registryKey) {
			const stepKey = resolveConversationStepKey(stepIndex, agent);
			const existing = hooks.get(stepKey);
			if (existing) {
				registryKeys.set(stepKey, registryKey);
				return existing;
			}
			const relayWriter = createRelayWriter({ dir, stepKey, deps: deps.relay });
			const watcher = createConversationRequestsWatcher({
				dir,
				stepKey,
				registry,
				registryKey,
				relayWriter,
				deps: deps.watcher,
			});
			watcher.start();
			watchers.set(stepKey, watcher);
			registryKeys.set(stepKey, registryKey);
			const hook: ConversationRelayHook = {
				stepKey,
				appendParsedLine(line) {
					relayWriter.appendLine(line);
				},
				appendMarker(marker) {
					relayWriter.appendMarker(marker);
				},
				requestsOffset() {
					return watcher.requestsOffset();
				},
			};
			hooks.set(stepKey, hook);
			return hook;
		},
		conversingKeys: currentConversingKeys,
		conversingRegistryKeys(now) {
			return [...currentConversingKeys(now)].map((stepKey) => registryKeys.get(stepKey) ?? stepKey);
		},
		stopAll() {
			for (const watcher of watchers.values()) watcher.stop();
			watchers.clear();
		},
		clearHeartbeats() {
			clearBridgeHeartbeats(asyncDir);
		},
	};
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LingerOptions {
	bridge: RunnerConversationBridge;
	deps?: {
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
		maxLingerMs?: number;
		tickMs?: number;
	};
}

/** Q3=A: after finalize, keep the runner alive while ≥1 conversing child has
 *  a fresh heartbeat; exit as soon as conversations end (or the cap hits). */
export async function lingerForConversations(options: LingerOptions): Promise<void> {
	const { bridge, deps = {} } = options;
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? defaultSleep;
	const maxLingerMs = deps.maxLingerMs ?? DEFAULT_MAX_LINGER_MS;
	const tickMs = deps.tickMs ?? DEFAULT_LINGER_TICK_MS;
	const deadline = now() + maxLingerMs;
	for (;;) {
		if (bridge.conversingKeys(now()).size === 0) return;
		if (now() >= deadline) return;
		await sleep(tickMs);
	}
}