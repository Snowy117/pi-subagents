/**
 * resolveChildChannel — THE single sync/async branch point (R0).
 *
 * Every child conversation, foreground or async, is resolved into a
 * ChildConversationChannel by this one function:
 *
 * - foreground target → resident registry entry (dead entries dropped), else
 *   registry-guarded session reopen → LocalRpcChannel;
 * - async queued/running → AsyncBridgeChannel (bounded boot retry ≤2s for
 *   the runner-side bridge; a runner death during boot falls through);
 * - async complete/failed/paused → wait for the runner pid to die (ESRCH,
 *   bounded ≤5s; the runner must be gone before the parent may reopen its
 *   child's session — single-writer invariant) → reopen → LocalRpcChannel;
 * - otherwise undefined (degraded surface).
 *
 * The reopen bridge stays the only session-file writer path and is
 * registry-guarded; the bridge never bypasses the child as the session
 * writer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PersistentRpcChild } from "../../runs/persistent/rpc-child-registry.ts";
import type { AsyncRunSummary } from "../../runs/background/async-status.ts";
import { ASYNC_DIR } from "../../shared/types.ts";
import { conversationDir, resolveConversationStepKey } from "../../runs/background/runner/conversation-bridge.ts";
import { createLocalRpcChannel, type ChildConversationChannel } from "../child-conversation/channel.ts";
import { createAsyncBridgeChannel, relayHasTerminalMarker, type AsyncBridgeChannelOptions, type BridgeChannelFs } from "./async-bridge-channel.ts";
import type { ReopenBridge } from "./reopen-bridge.ts";
import type { SteerViewTarget } from "./target-model.ts";

/** Bounded wait for the runner-side bridge to appear (dir is created at
 *  runner start; a queued run may not have spawned the runner yet). */
export const DEFAULT_BRIDGE_BOOT_RETRY_MS = 2000;
/** Bounded wait for the runner pid to die before reopening a terminal child
 *  (the runner may still be closing children / lingering on other chats). */
export const DEFAULT_PID_DEATH_WAIT_MS = 5000;
export const DEFAULT_RESOLVE_POLL_MS = 100;
export const ALL_ASYNC_STATES: AsyncRunSummary["state"][] = ["queued", "running", "complete", "failed", "paused"];

interface RunState {
	state?: AsyncRunSummary["state"];
	pid?: number;
}

export interface ChildChannelResolverDeps {
	/** Foreground branch: resident child for a foreground target (registry
	 *  get; dead entries dropped so reopen can take over). */
	getForegroundResident(target: SteerViewTarget): PersistentRpcChild | undefined;
	/** Registry-guarded session reopen (also used for terminal async). */
	reopenBridge: ReopenBridge;
	fs?: BridgeChannelFs;
	/** State fallback when `asyncDir/status.json` is missing/unreadable. */
	listRuns?: (root: string, options: { states?: AsyncRunSummary["state"][]; sessionId?: string; resultsDir?: string }) => AsyncRunSummary[];
	asyncDirRoot?: string;
	/** Reserved for parity with the dispatch contract; a parent-side resolver
	 *  does not need its own pid today. */
	processId?: number;
	/** pid liveness probe: returns false only when the pid is dead (ESRCH). */
	kill?: (pid: number, signal?: number) => boolean;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	bridgeBootRetryMs?: number;
	pidDeathWaitMs?: number;
	resolvePollMs?: number;
	bridgeOptions?: Omit<AsyncBridgeChannelOptions, "key" | "runnerPid" | "fs" | "kill" | "now">;
}

export type ResolveChildChannel = (ctx: ExtensionContext, target: SteerViewTarget) => Promise<ChildConversationChannel | undefined>;

function defaultKill(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRunState(asyncDir: string, fsImpl: BridgeChannelFs): RunState | undefined {
	let text: string;
	try {
		text = fsImpl.readFileSync(path.join(asyncDir, "status.json"), "utf-8");
	} catch {
		return undefined;
	}
	try {
		const raw = JSON.parse(text) as { state?: unknown; pid?: unknown };
		const state = typeof raw.state === "string" && ALL_ASYNC_STATES.includes(raw.state as AsyncRunSummary["state"])
			? raw.state as AsyncRunSummary["state"]
			: undefined;
		const pid = typeof raw.pid === "number" && Number.isFinite(raw.pid) && raw.pid > 0 ? raw.pid : undefined;
		return { state, pid };
	} catch {
		return undefined;
	}
}

export function createChildChannelResolver(deps: ChildChannelResolverDeps): ResolveChildChannel {
	const { getForegroundResident, reopenBridge } = deps;
	const fsImpl = deps.fs ?? fs;
	const kill = deps.kill ?? defaultKill;
	const sleep = deps.sleep ?? defaultSleep;
	const now = deps.now ?? Date.now;
	const bootRetryMs = deps.bridgeBootRetryMs ?? DEFAULT_BRIDGE_BOOT_RETRY_MS;
	const pidDeathWaitMs = deps.pidDeathWaitMs ?? DEFAULT_PID_DEATH_WAIT_MS;
	const pollMs = deps.resolvePollMs ?? DEFAULT_RESOLVE_POLL_MS;

	const waitForPidDeath = async (pid: number): Promise<boolean> => {
		const deadline = now() + pidDeathWaitMs;
		while (now() < deadline) {
			if (!kill(pid, 0)) return true;
			await sleep(pollMs);
		}
		return !kill(pid, 0);
	};

	const resolveForeground = (target: SteerViewTarget): ChildConversationChannel | undefined => {
		const resident = getForegroundResident(target);
		if (resident) return createLocalRpcChannel(resident);
		if (!target.sessionFile) return undefined;
		const reopened = reopenBridge.reopen(target);
		return reopened ? createLocalRpcChannel(reopened) : undefined;
	};

	const resolveOpenAsyncBridge = async (target: SteerViewTarget, state: RunState): Promise<ChildConversationChannel | undefined> => {
		const stepKey = resolveConversationStepKey(target.index, target.agent);
		const startedAt = now();
		if (fsImpl.existsSync(conversationDir(target.asyncDir!)) && relayHasTerminalMarker(target.asyncDir!, stepKey, fsImpl)) {
			// The child is already gone mid-run; the runner owns the session,
			// so there is nothing to converse with until the run is terminal.
			return undefined;
		}
		for (;;) {
			if (fsImpl.existsSync(conversationDir(target.asyncDir!))) break;
			if (state.pid !== undefined && !kill(state.pid, 0)) return undefined;
			if (now() - startedAt >= bootRetryMs) return undefined;
			await sleep(pollMs);
		}
		return createAsyncBridgeChannel(target.asyncDir!, stepKey, {
			...deps.bridgeOptions,
			key: `${target.runId}/${target.index}`,
			runnerPid: state.pid,
			fs: fsImpl,
			kill,
			now,
		});
	};

	return async (_ctx, target) => {
		if (target.kind === "foreground") return resolveForeground(target);
		if (!target.asyncDir) return undefined;

		let state = readRunState(target.asyncDir, fsImpl);
		if (state === undefined) {
			state = {};
			if (deps.listRuns) {
				try {
					const run = deps.listRuns(deps.asyncDirRoot ?? ASYNC_DIR, { states: [...ALL_ASYNC_STATES] })
						.find((candidate) => candidate.id === target.runId);
					if (run) state.state = run.state;
				} catch {
					// A listing failure must not block resolution; the status
					// file is authoritative when it exists.
				}
			}
		}

		if (state.state === undefined || state.state === "queued" || state.state === "running") {
			return resolveOpenAsyncBridge(target, state);
		}

		// Terminal run: reopening the child's session requires the runner to be
		// fully gone (it may still be closing children / lingering on another
		// conversation) — two writers on one session file are forbidden.
		if (!target.sessionFile) return undefined;
		if (state.pid !== undefined && !(await waitForPidDeath(state.pid))) return undefined;
		const reopened = reopenBridge.reopen(target);
		return reopened ? createLocalRpcChannel(reopened) : undefined;
	};
}