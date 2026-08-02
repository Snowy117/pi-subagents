/**
 * Relay tail reader + terminal-marker detection shared by the parent-side
 * async bridge channel (`async-bridge-channel.ts`) and the channel resolver
 * (`child-channel.ts`).
 *
 * The relay (`<stepKey>.stdout.jsonl`) is a single-writer LF JSONL log: the
 * runner mirrors the child's raw RPC stdout lines and stamps synthetic
 * lifecycle markers (`child_ready` / `child_settled` / `child_closed` /
 * `child_unavailable` / `pong` / `relay_reset`). Consumers tail it with a
 * byte cursor so pre-open history (already seeded from the child transcript)
 * is never re-delivered, and resync when the file is truncated at the cap.
 */

import * as fs from "node:fs";
import { conversationDir, relayFilePath } from "../../runs/background/runner/conversation-bridge/paths.ts";

export type BridgeChannelFs = Pick<
	typeof fs,
	| "appendFileSync" | "closeSync" | "existsSync" | "mkdirSync"
	| "openSync" | "readFileSync" | "readSync" | "rmSync" | "statSync" | "writeFileSync"
>;

/** Markers meaning the child is gone; mid-run there is nothing to converse
 *  with until the run is terminal (resolver refuses bridge channels for
 *  these). */
const TERMINAL_MARKER_TYPES = new Set(["child_closed", "child_unavailable"]);

/** True when the relay already contains a terminal marker for this stepKey.
 *  `asyncDir` is the run root (the conversation dir is derived). */
export function relayHasTerminalMarker(asyncDir: string, stepKey: string, fsImpl: BridgeChannelFs = fs): boolean {
	let text: string;
	try {
		text = fsImpl.readFileSync(relayFilePath(conversationDir(asyncDir), stepKey), "utf-8");
	} catch {
		return false;
	}
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let record: { type?: unknown };
		try {
			record = JSON.parse(line) as typeof record;
		} catch {
			continue;
		}
		if (typeof record.type === "string" && TERMINAL_MARKER_TYPES.has(record.type)) return true;
	}
	return false;
}

export interface RelayTail {
	poll(): { lines: string[]; reset: boolean };
}

/** Line-framed tail over the relay file with a byte cursor. Starts at the
 *  file's current EOF so pre-open history (already seeded from the child
 *  transcript) is never re-delivered. ENOENT (bridge not started) is empty;
 *  a truncation (relay_reset cap) returns `reset: true` and resyncs from the
 *  new EOF without re-delivering the preserved tail. */
export function createRelayTail(filePath: string, fsImpl: BridgeChannelFs): RelayTail {
	let offset = 0;
	let partial = Buffer.alloc(0);
	try {
		offset = fsImpl.statSync(filePath).size;
	} catch {
		// Relay not written yet; the offset stays 0 so the first lines that
		// appear (child_ready etc.) are picked up.
	}
	return {
		poll(): { lines: string[]; reset: boolean } {
			let size: number;
			try {
				size = fsImpl.statSync(filePath).size;
			} catch {
				// Bridge directory removed/rotated: stay quiet and keep polling.
				return { lines: [], reset: false };
			}
			if (size < offset) {
				// Relay truncated (relay_reset cap): the preserved tail was
				// already delivered; skip it and resync from the new EOF.
				offset = size;
				partial = Buffer.alloc(0);
				return { lines: [], reset: true };
			}
			if (size === offset) return { lines: [], reset: false };
			let chunk: Buffer;
			try {
				const fd = fsImpl.openSync(filePath, "r");
				try {
					chunk = Buffer.alloc(size - offset);
					const bytesRead = fsImpl.readSync(fd, chunk, 0, chunk.length, offset);
					offset += bytesRead;
					chunk = chunk.subarray(0, bytesRead);
				} finally {
					fsImpl.closeSync(fd);
				}
			} catch {
				// Best-effort read; a raced file must never break the viewer.
				return { lines: [], reset: false };
			}
			const combined = Buffer.concat([partial, chunk]);
			const lines: string[] = [];
			let start = 0;
			for (let index = 0; index < combined.length; index++) {
				if (combined[index] !== 10) continue;
				lines.push(combined.subarray(start, index).toString("utf-8").replace(/\r$/, ""));
				start = index + 1;
			}
			partial = combined.subarray(start);
			return { lines, reset: false };
		},
	};
}