/**
 * Parent-side registry of resident RPC children.
 *
 * Option B lifecycle: every execution child is a persistent Pi RPC process.
 * This registry is the single owner of that lifecycle on the parent side. It
 * guarantees one registry entry per child key (one writer per session file)
 * and provides the eviction paths (viewer close, target switch, idle expiry,
 * registry cap, parent session shutdown).
 */

import type { ChildProcess } from "node:child_process";
import { trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import type { RpcWrite } from "./rpc-protocol.ts";

/** Grace period after stdin EOF before escalating to SIGTERM. */
const DEFAULT_CLOSE_GRACE_MS = 2000;
/** Grace period after SIGTERM before SIGKILL. */
const DEFAULT_SIGTERM_GRACE_MS = 3000;

export interface PersistentRpcChild {
	key: string;
	sessionFile?: string;
	proc: ChildProcess;
	write: RpcWrite;
	settled: boolean;
	lastActivityAt: number;
	pendingDialogs: Map<string, { resolve: (value: unknown) => void }>;
	/** Current dialogs pending a reply from the viewer, keyed by request id. */
	pendingRequestIds: Set<string>;
	/** Resolves when the process closes (exit or error). */
	closed: Promise<void>;
	close(kind: "graceful" | "force"): Promise<void>;
}

export interface RpcChildRegistryDeps {
	closeGraceMs?: number;
	sigtermGraceMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface RegistryEvictionOptions {
	/** Key(s) excluded from eviction. Accepts a single key or an array (the
	 *  runner bridge excludes every conversing child at once). */
	except?: string | readonly string[];
}

export interface RpcChildRegistry {
	get(key: string): PersistentRpcChild | undefined;
	has(key: string): boolean;
	entries(): PersistentRpcChild[];
	settledCount(): number;
	register(child: PersistentRpcChild): void;
	unregister(key: string): boolean;
	evictIdle(idleMs: number, opts?: RegistryEvictionOptions): Promise<string[]>;
	evictOverflow(maxResident: number, opts?: RegistryEvictionOptions): Promise<string[]>;
	closeAll(kind: "graceful" | "force"): Promise<void>;
}

function excludedKeys(opts?: RegistryEvictionOptions): Set<string> | undefined {
	const raw = opts?.except;
	if (raw === undefined) return undefined;
	const keys = typeof raw === "string" ? [raw] : raw;
	return keys.length > 0 ? new Set(keys) : undefined;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRpcChildRegistry(deps: RpcChildRegistryDeps = {}): RpcChildRegistry {
	const closeGraceMs = deps.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
	const sigtermGraceMs = deps.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? defaultSleep;
	const children = new Map<string, PersistentRpcChild>();

	return {
		get(key: string): PersistentRpcChild | undefined {
			return children.get(key);
		},
		has(key: string): boolean {
			return children.has(key);
		},
		entries(): PersistentRpcChild[] {
			return [...children.values()];
		},
		settledCount(): number {
			let count = 0;
			for (const child of children.values()) if (child.settled) count++;
			return count;
		},
		register(child: PersistentRpcChild): void {
			children.set(child.key, child);
		},
		unregister(key: string): boolean {
			return children.delete(key);
		},
		async evictIdle(idleMs: number, opts?: RegistryEvictionOptions): Promise<string[]> {
			const cutoff = now() - idleMs;
			const excluded = excludedKeys(opts);
			const idle = [...children.values()].filter(
				(child) => child.settled && child.lastActivityAt <= cutoff && !(excluded?.has(child.key) ?? false),
			);
			const evicted: string[] = [];
			for (const child of idle) {
				children.delete(child.key);
				await child.close("graceful");
				evicted.push(child.key);
			}
			return evicted;
		},
		async evictOverflow(maxResident: number, opts?: RegistryEvictionOptions): Promise<string[]> {
			const excluded = excludedKeys(opts);
			const settled = [...children.values()]
				.filter((child) => child.settled && !(excluded?.has(child.key) ?? false))
				.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
			const overflow = settled.length - maxResident;
			if (overflow <= 0) return [];
			const evicted: string[] = [];
			for (const child of settled.slice(0, overflow)) {
				children.delete(child.key);
				await child.close("graceful");
				evicted.push(child.key);
			}
			return evicted;
		},
		async closeAll(kind: "graceful" | "force"): Promise<void> {
			const pending = [...children.values()];
			children.clear();
			await Promise.all(pending.map((child) => child.close(kind)));
		},
	};
}

/**
 * Build the `close()` implementation for a resident child.
 *
 * Graceful: cancel pending dialogs, close stdin (EOF → Pi shutdown → session
 * persist), wait for process exit with a bounded grace, then SIGTERM/SIGKILL
 * escalation. Force: immediate SIGTERM/SIGKILL without stdin EOF.
 */
export function createRpcChildCloser(
	child: Omit<PersistentRpcChild, "close">,
	deps: RpcChildRegistryDeps = {},
): PersistentRpcChild["close"] {
	const closeGraceMs = deps.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
	const sigtermGraceMs = deps.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
	const sleep = deps.sleep ?? defaultSleep;
	let closed = false;

	return async (kind: "graceful" | "force") => {
		if (closed) return;
		closed = true;

		// Cancel pending extension dialogs so the child never waits on a
		// reply that will never arrive during shutdown.
		for (const requestId of child.pendingRequestIds) {
			const pending = child.pendingDialogs.get(requestId);
			if (pending) {
				child.pendingDialogs.delete(requestId);
				pending.resolve({ cancelled: true });
			}
		}
		child.pendingRequestIds.clear();

		if (kind === "graceful") {
			child.write.close(); // stdin EOF → Pi graceful shutdown + session persist
			const exited = await Promise.race([
				child.closed.then(() => true),
				sleep(closeGraceMs).then(() => false),
			]);
			if (exited) return;
			trySignalChild(child.proc, "SIGTERM");
			const termExited = await Promise.race([
				child.closed.then(() => true),
				sleep(sigtermGraceMs).then(() => false),
			]);
			if (termExited) return;
			trySignalChild(child.proc, "SIGKILL");
			return;
		}

		trySignalChild(child.proc, "SIGTERM");
		const termExited = await Promise.race([
			child.closed.then(() => true),
			sleep(sigtermGraceMs).then(() => false),
		]);
		if (termExited) return;
		trySignalChild(child.proc, "SIGKILL");
	};
}
