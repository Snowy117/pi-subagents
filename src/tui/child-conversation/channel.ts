/**
 * ChildConversationChannel — the single abstraction the child-conversation
 * view layer talks to (R0). A channel owns one child's outbound requests and
 * inbound raw RPC JSONL stdout. Foreground residents are wrapped as
 * LocalRpcChannel; async runs will get a bridge-backed channel in a later
 * phase, so view code never branches on sync/async.
 */

import type { PersistentRpcChild } from "../../runs/persistent/rpc-child-registry.ts";
import { createRpcLineReader, type RpcLineReader } from "../../runs/persistent/rpc-protocol.ts";

export interface ChildConversationChannel {
	/** Registry/bridge key identifying the child ("runId/index" or "runId/stepIndex/agent"). */
	readonly key: string;
	/** Send an outbound record (prompt, get_commands, abort, cycle_model...).
	 *  Returns the request id for response correlation. */
	write(record: Record<string, unknown>, id?: string): string;
	/** Subscribe to raw child RPC JSONL stdout lines; returns an unsubscribe. */
	onStdoutLine(cb: (line: string) => void): () => void;
	readonly settled: boolean;
	/** Resolves when the underlying channel dies (process exit / bridge EOF). */
	readonly closed: Promise<void>;
	/** Refresh the activity timestamp so idle/cap eviction skips this child. */
	touch(): void;
	close(kind: "graceful" | "force"): Promise<void>;
	/** Local children only: the underlying process exit code (null while
	 *  running, a number once the process ended). Bridge-backed channels leave
	 *  this undefined — they resolve `closed` instead. Lets routeInput fast-path
	 *  refuse to write into a dead child without awaiting `closed`. */
	readonly exitCode?: number | null;
	/** Stop the viewer-side conversation session without terminating the child.
	 *  Local channels no-op (a settled resident stays owned by the registry);
	 *  bridge channels stop their heartbeat + poll timers so the runner can
	 *  exit. Host-editor mode calls this on close/target-switch. */
	endConversation?(): void;
}

/** Thin wrapper over a resident foreground RPC child. The line reader is
 *  created lazily on first subscriber (the existing parent-side stdout
 *  listeners stay untouched until the conversation opens). */
export function createLocalRpcChannel(resident: PersistentRpcChild): ChildConversationChannel {
	let reader: RpcLineReader | undefined;
	const handlers = new Set<(line: string) => void>();

	return {
		key: resident.key,
		write(record, id) {
			return resident.write.write(record, id);
		},
		get exitCode() {
			return resident.proc.exitCode;
		},
		onStdoutLine(cb) {
			handlers.add(cb);
			if (handlers.size === 1 && !reader && resident.proc.stdout) {
				reader = createRpcLineReader(resident.proc.stdout);
				reader.onLine((line) => {
					for (const handler of handlers) handler(line);
				});
			}
			return () => {
				handlers.delete(cb);
			};
		},
		get settled() { return resident.settled; },
		get closed() { return resident.closed; },
		touch() {
			resident.lastActivityAt = Date.now();
		},
		close(kind) {
			return resident.close(kind);
		},
	};
}