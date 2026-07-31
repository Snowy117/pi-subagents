/**
 * Session reopen bridge (Phase 5): after a settled resident child is evicted,
 * its persisted Pi session can be reopened with a fresh RPC process when the
 * user selects the child again. The registry guards against a second writer:
 * reopen only happens when no resident entry exists for the child key.
 */

import { spawn } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { attachRpcProtocol } from "../../runs/persistent/rpc-protocol.ts";
import { createRpcChildCloser, type PersistentRpcChild, type RpcChildRegistry } from "../../runs/persistent/rpc-child-registry.ts";
import { getPiSpawnCommand } from "../../runs/shared/pi-spawn.ts";
import type { SteerViewTarget } from "./target-model.ts";

export interface ReopenBridgeOptions {
	registry: RpcChildRegistry;
	getChildLaunchArgs: (target: SteerViewTarget) => string[] | undefined;
	cwd: string;
	env?: NodeJS.ProcessEnv;
}

export interface ReopenBridge {
	/** Reopen an evicted child's session; returns the resident child or undefined when guarded/absent. */
	reopen(target: SteerViewTarget): PersistentRpcChild | undefined;
	close(): void;
}

export function createReopenBridge(options: ReopenBridgeOptions): ReopenBridge {
	const { registry, getChildLaunchArgs, cwd, env } = options;
	const open = (target: SteerViewTarget): PersistentRpcChild | undefined => {
		// One-writer invariant: never reopen while a resident entry exists.
		const key = `${target.runId}/${target.index}`;
		if (registry.has(key)) return registry.get(key);
		if (!target.sessionFile) return undefined;
		const args = getChildLaunchArgs(target);
		if (!args) return undefined;
		const spawnSpec = getPiSpawnCommand(args);
		const proc = spawn(spawnSpec.command, spawnSpec.args, {
			cwd,
			env: env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const rpcWrite = attachRpcProtocol(proc).write;
		const closed = new Promise<void>((resolve) => {
			proc.once("close", () => resolve());
			proc.once("error", () => resolve());
		});
		const resident: PersistentRpcChild = {
			key,
			sessionFile: target.sessionFile,
			proc,
			write: rpcWrite,
			settled: true,
			lastActivityAt: Date.now(),
			pendingDialogs: new Map(),
			pendingRequestIds: new Set(),
			closed,
			close: async () => {},
		};
		resident.close = createRpcChildCloser(resident, {});
		registry.register(resident);
		return resident;
	};
	return {
		reopen: open,
		close() {
			void registry.closeAll("graceful");
		},
	};
}
