import * as fs from "node:fs";
import type { RpcChildRegistry } from "../../../persistent/rpc-child-registry.ts";
import type { ConversationMarker, ConversationRequest } from "./types.ts";
import type { RelayWriter } from "./relay-writer.ts";
import { requestsFilePath } from "./paths.ts";

export const DEFAULT_REQUESTS_POLL_MS = 250;
/** Launch-window grace: requests arriving before the child registers are
 *  buffered briefly instead of being answered with child_unavailable. */
export const DEFAULT_LAUNCH_GRACE_MS = 2000;
export const MAX_PENDING_REQUESTS = 64;
const MAX_REQUEST_LINE_BYTES = 1024 * 1024;

export interface RequestsWatcherDeps {
	pollMs?: number;
	launchGraceMs?: number;
	now?: () => number;
}

export interface ConversationRequestsWatcher {
	start(): void;
	stop(): void;
	requestsOffset(): number;
}

// Records the viewer may route to the child through the bridge: the core
// conversation commands plus the child-agent operations used by the key-route
// (abort / model / thinking) and the state probe. Viewer-hostile session
// mutations (new_session, switch_session, fork, clone, ...) are intentionally
// NOT forwardable through the bridge.
const REQUEST_TYPES = new Set([
	"prompt",
	"get_commands",
	"ping",
	"abort",
	"get_state",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"get_available_thinking_levels",
]);

function parseRequestRecord(line: string): ConversationRequest | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	if (typeof record.id !== "string" || !record.id.trim()) return undefined;
	if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) return undefined;
	if (typeof record.type !== "string" || !REQUEST_TYPES.has(record.type)) return undefined;
	return { ...record } as ConversationRequest;
}

/** Consume `<stepKey>.requests.jsonl` from a byte offset and forward each
 *  validated record to the child's RPC stdin (or answer it locally). */
export function createConversationRequestsWatcher(options: {
	dir: string;
	stepKey: string;
	registry: RpcChildRegistry;
	registryKey: string;
	relayWriter: RelayWriter;
	deps?: RequestsWatcherDeps;
}): ConversationRequestsWatcher {
	const { dir, stepKey, registry, registryKey, relayWriter } = options;
	const deps = options.deps ?? {};
	const pollMs = deps.pollMs ?? DEFAULT_REQUESTS_POLL_MS;
	const launchGraceMs = deps.launchGraceMs ?? DEFAULT_LAUNCH_GRACE_MS;
	const now = deps.now ?? Date.now;
	const filePath = requestsFilePath(dir, stepKey);

	let offset = 0;
	let pendingPartial = "";
	let launchedAt = now();
	let everResident = false;
	let pending: ConversationRequest[] = [];
	let timer: NodeJS.Timeout | undefined;

	const writeMarker = (marker: ConversationMarker): void => {
		relayWriter.appendMarker(marker);
	};

	const readBatch = (): ConversationRequest[] => {
		let size: number;
		try {
			size = fs.statSync(filePath).size;
		} catch {
			// Missing requests file (parent never opened a conversation) is
			// normal; there is simply nothing to consume.
			return [];
		}
		if (size === offset) return [];
		if (size < offset) {
			// Requests file truncated/rotated: resync from the top.
			offset = 0;
			pendingPartial = "";
		}
		let data: Buffer;
		try {
			const fd = fs.openSync(filePath, "r");
			try {
				data = Buffer.alloc(size - offset);
				fs.readSync(fd, data, 0, data.length, offset);
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			// Best-effort read; a raced file must never crash the runner.
			return [];
		}
		offset = size;
		pendingPartial += data.toString("utf-8");
		if (Buffer.byteLength(pendingPartial, "utf-8") > MAX_REQUEST_LINE_BYTES) {
			// Oversized/never-terminated record: drop it and continue.
			pendingPartial = "";
			return [];
		}
		const lines = pendingPartial.split("\n");
		pendingPartial = lines.pop() ?? "";
		const records: ConversationRequest[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			const record = parseRequestRecord(line);
			if (record) records.push(record);
		}
		return records;
	};

	const forward = (record: ConversationRequest): void => {
		if (record.type === "ping") {
			// Ping is answered locally; the pong lives in the relay so the
			// parent correlates it the same way it correlates child output.
			writeMarker({ type: "pong", key: registryKey, requestId: record.id });
			return;
		}
		const resident = registry.get(registryKey);
		if (!resident) {
			writeMarker({ type: "child_unavailable", key: registryKey, reason: "no-resident" });
			return;
		}
		// Forward verbatim to the child RPC stdin (raw record, original request
		// id preserved) — RpcWrite.write() would overwrite the id with a fresh
		// random one and break parent-side correlation. The child stays the sole
		// session-file writer; a dead stdin is swallowed by RpcWrite.
		resident.write.writeLine(JSON.stringify(record));
	};

	const handleBatch = (records: ConversationRequest[]): void => {
		if (pending.length > 0 && now() - launchedAt > launchGraceMs) {
			// The child never appeared during the launch window.
			for (const record of pending) {
				writeMarker({ type: "child_unavailable", key: registryKey, reason: "no-resident" });
			}
			pending = [];
		}
		if (pending.length > 0 && registry.get(registryKey)) {
			// The child registered since the requests were buffered; a batch
			// with no new lines must still flush them.
			everResident = true;
			for (const buffered of pending) forward(buffered);
			pending = [];
		}
		for (const record of records) {
			const live = registry.get(registryKey);
			if (live) {
				everResident = true;
				forward(record);
				continue;
			}
			if (!everResident && now() - launchedAt <= launchGraceMs && pending.length < MAX_PENDING_REQUESTS) {
				// Bridge boot race: the child may still be launching. Hold the
				// request briefly instead of declaring it unavailable.
				pending.push(record);
				continue;
			}
			writeMarker({ type: "child_unavailable", key: registryKey, reason: "no-resident" });
		}
	};

	return {
		start() {
			if (timer) return;
			timer = setInterval(() => handleBatch(readBatch()), pollMs);
			timer.unref?.();
		},
		stop() {
			if (!timer) return;
			clearInterval(timer);
			timer = undefined;
			pending = [];
		},
		requestsOffset() {
			return offset;
		},
	};
}