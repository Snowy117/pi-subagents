/**
 * Parent-side AsyncBridgeChannel — a ChildConversationChannel backed by the
 * runner-side conversation bridge (Phase 4, `src/runs/background/runner/
 * conversation-bridge/`). The runner owns the child RPC process; the parent
 * talks to it through files under `<asyncDir>/conversation/`:
 *
 * - `<stepKey>.stdout.jsonl` — runner→parent relay: raw child RPC stdout
 *   lines + synthetic lifecycle markers (child_ready / child_settled /
 *   child_closed / child_unavailable / pong / relay_reset);
 * - `<stepKey>.requests.jsonl` — parent→runner requests (prompt /
 *   get_commands / ping), forwarded verbatim to the child stdin by the
 *   runner's requests watcher (id preserved);
 * - `<stepKey>.active` — parent heartbeat `{ts}`; a fresh heartbeat (TTL
 *   30s) marks the child as "conversing" so the runner excludes it from
 *   eviction and lingers after finalize instead of closing it.
 *
 * The channel consumes synthetic markers internally; every other relay line
 * is delivered verbatim to `onStdoutLine` subscribers, so the child
 * conversation assembler sees byte-identical RPC JSONL like a foreground
 * LocalRpcChannel would.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { ChildConversationChannel } from "../child-conversation/channel.ts";
import {
	conversationDir,
	heartbeatFilePath,
	relayFilePath,
	requestsFilePath,
	type ConversationMarker,
} from "../../runs/background/runner/conversation-bridge.ts";

/** Tail poll cadence (same as the transcript-tail polling used elsewhere). */
export const DEFAULT_BRIDGE_POLL_MS = 250;
/** Heartbeat rewrite cadence; TTL on the runner side is 30s. */
export const DEFAULT_BRIDGE_HEARTBEAT_INTERVAL_MS = 5000;
/** Bridge considered unreachable only when the runner pid is dead AND no
 *  relay content arrived for this long. A live runner (or any relay traffic)
 *  keeps the channel open regardless of quiet periods. */
export const DEFAULT_BRIDGE_STALE_CLOSE_MS = 10_000;

import {
	createRelayTail,
	relayHasTerminalMarker,
	type BridgeChannelFs,
} from "./bridge-relay-tail.ts";

export type { BridgeChannelFs } from "./bridge-relay-tail.ts";
export { relayHasTerminalMarker } from "./bridge-relay-tail.ts";

export interface AsyncBridgeChannelOptions {
	/** Channel key ("runId/index"); defaults to the stepKey. */
	key?: string;
	/** Runner pid from `status.json`; enables the staleness close. */
	runnerPid?: number;
	pollMs?: number;
	heartbeatIntervalMs?: number;
	staleCloseMs?: number;
	fs?: BridgeChannelFs;
	kill?: (pid: number, signal?: number) => boolean;
	now?: () => number;
	randomId?: () => string;
}

export interface AsyncBridgeChannel extends ChildConversationChannel {
	endConversation(): void;
	dispose(): void;
}

const SYNTHETIC_MARKER_TYPES = new Set([
	"child_ready", "child_settled", "child_closed", "child_unavailable", "pong", "relay_reset",
]);

const openBridgeChannels = new Set<AsyncBridgeChannel>();

/** Close every still-open parent-side bridge channel (session shutdown). */
export function closeAllOpenAsyncBridgeChannels(): void {
	for (const channel of [...openBridgeChannels]) channel.close("force");
}

export function createAsyncBridgeChannel(
	asyncDir: string,
	stepKey: string,
	options: AsyncBridgeChannelOptions = {},
): AsyncBridgeChannel {
	const fsImpl = options.fs ?? fs;
	const pollMs = options.pollMs ?? DEFAULT_BRIDGE_POLL_MS;
	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_BRIDGE_HEARTBEAT_INTERVAL_MS;
	const staleCloseMs = options.staleCloseMs ?? DEFAULT_BRIDGE_STALE_CLOSE_MS;
	const now = options.now ?? Date.now;
	const randomId = options.randomId ?? randomUUID;
	const key = options.key ?? stepKey;
	const runnerPid = options.runnerPid;
	const kill = options.kill ?? ((pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ESRCH";
		}
	});

	const dir = conversationDir(asyncDir);
	const relayPath = relayFilePath(dir, stepKey);
	const requestsPath = requestsFilePath(dir, stepKey);
	const heartbeatPath = heartbeatFilePath(dir, stepKey);

	const handlers = new Set<(line: string) => void>();
	const relayTail = createRelayTail(relayPath, fsImpl);
	let settledFlag = false;
	let lastRelayAt = now();
	let heartbeatTimer: NodeJS.Timeout | undefined;
	let pollTimer: NodeJS.Timeout | undefined;
	let tornDown = false;
	let resolveClosed!: () => void;
	const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
	let channel: AsyncBridgeChannel;

	const writeHeartbeat = (): void => {
		try {
			// The conversation dir may not exist yet (channel opened for a
			// queued run before the runner starts); the heartbeat must still
			// land so the runner's linger check sees it right after finalize.
			fsImpl.mkdirSync(dir, { recursive: true });
			fsImpl.writeFileSync(heartbeatPath, JSON.stringify({ ts: now() }), "utf-8");
		} catch {
			// Best-effort; a stale/failed heartbeat just lets the runner's
			// 30s TTL expire, which is the designed failure mode.
		}
	};

	const stopHeartbeat = (): void => {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		try {
			fsImpl.rmSync(heartbeatPath, { force: true });
		} catch {
			// Best-effort housekeeping; the runner TTL covers a leftover file.
		}
	};

	const stopPolling = (): void => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	};

	const teardown = (_reason: string): void => {
		if (tornDown) return;
		tornDown = true;
		stopHeartbeat();
		stopPolling();
		openBridgeChannels.delete(channel);
		resolveClosed();
	};

	const evaluateClosed = (): void => {
		if (tornDown) return;
		if (runnerPid !== undefined && !kill(runnerPid, 0) && now() - lastRelayAt >= staleCloseMs) {
			teardown("runner-pid-dead");
		}
	};

	const handleMarker = (marker: ConversationMarker): void => {
		switch (marker.type) {
			case "child_settled":
				settledFlag = true;
				return;
			case "child_closed":
			case "child_unavailable":
				teardown(marker.type);
				return;
			default:
				// child_ready (bridge usable), pong, relay_reset: nothing to do.
				return;
		}
	};

	const poll = (): void => {
		const { lines } = relayTail.poll();
		let relayActivity = false;
		for (const line of lines) {
			relayActivity = true;
			let marker: ConversationMarker | undefined;
			try {
				const record = JSON.parse(line) as { type?: unknown };
				if (typeof record.type === "string" && SYNTHETIC_MARKER_TYPES.has(record.type)) {
					marker = record as ConversationMarker;
				}
			} catch {
				// Not JSON: forward verbatim (the child's stdout is JSONL, but
				// a malformed line must not wedge the viewer).
			}
			if (marker) {
				handleMarker(marker);
				continue;
			}
			for (const handler of handlers) handler(line);
		}
		if (relayActivity) lastRelayAt = now();
		evaluateClosed();
	};

	writeHeartbeat();
	heartbeatTimer = setInterval(writeHeartbeat, heartbeatIntervalMs);
	heartbeatTimer.unref?.();
	pollTimer = setInterval(poll, pollMs);
	pollTimer.unref?.();

	channel = {
		key,
		write(record, id) {
			// Never overwrite the caller's id; the requests watcher correlates
			// by it, so prompt/get_commands responses reach the right caller.
			const requestId = typeof record.id === "string" && record.id
				? record.id
				: (id ?? randomId());
			const stamped = {
				...record,
				id: requestId,
				ts: typeof record.ts === "number" ? record.ts : now(),
			};
			try {
				fsImpl.mkdirSync(dir, { recursive: true });
				fsImpl.appendFileSync(requestsPath, `${JSON.stringify(stamped)}\n`, "utf-8");
			} catch {
				// Best-effort: a failed request must never crash the host; the
				// runner's watcher answers unreadable records with nothing.
			}
			return requestId;
		},
		onStdoutLine(cb) {
			handlers.add(cb);
			return () => { handlers.delete(cb); };
		},
		get settled() { return settledFlag; },
		get closed() { return closedPromise; },
		touch() {
			writeHeartbeat();
		},
		async close(kind) {
			teardown(`closed:${kind}`);
		},
		endConversation() {
			teardown("ended");
		},
		dispose() {
			teardown("disposed");
		},
	};
	openBridgeChannels.add(channel);
	return channel;
}