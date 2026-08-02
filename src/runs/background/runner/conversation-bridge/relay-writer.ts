import * as fs from "node:fs";
import * as path from "node:path";
import type { ConversationMarker } from "./types.ts";
import { relayFilePath } from "./paths.ts";

export const DEFAULT_RELAY_MAX_BYTES = 20 * 1024 * 1024;
/** Tail preserved when the relay exceeds its cap (still renders recent lines). */
export const RELAY_TAIL_RESERVE_BYTES = 1024 * 1024;

export interface RelayWriterDeps {
	maxBytes?: number;
	now?: () => number;
}

/** Single-writer LF JSONL sink for one child's raw stdout + lifecycle markers. */
export interface RelayWriter {
	appendLine(line: string): void;
	appendMarker(marker: ConversationMarker): void;
}

function initialFileSize(filePath: string): number {
	try {
		return fs.statSync(filePath).size;
	} catch {
		return 0;
	}
}

export function createRelayWriter(options: { dir: string; stepKey: string; deps?: RelayWriterDeps }): RelayWriter {
	const { dir, stepKey } = options;
	const deps = options.deps ?? {};
	const maxBytes = deps.maxBytes ?? DEFAULT_RELAY_MAX_BYTES;
	const now = deps.now ?? Date.now;
	const filePath = relayFilePath(dir, stepKey);
	try {
		// The writer is self-contained: the bridge manager also ensures the dir,
		// but standalone writers (and the pong/unavailable path) must not depend on it.
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
	} catch {
		// Best-effort; appends below fail silently and never crash the runner.
	}
	let bytes = initialFileSize(filePath);

	const appendChunk = (text: string): void => {
		const chunk = `${text}\n`;
		const chunkBytes = Buffer.byteLength(chunk, "utf-8");
		if (bytes + chunkBytes > maxBytes) truncateToTail();
		try {
			fs.appendFileSync(filePath, chunk, "utf-8");
		} catch {
			// Relay writes are best-effort; a failed append must never crash the runner.
			return;
		}
		bytes += chunkBytes;
	};

	const truncateToTail = (): void => {
		// Keep the most recent complete-line tail so viewers still render the
		// latest messages, then start the new content with a relay_reset marker
		// so tail-side consumers drop their fed cursor and resync.
		let tail = "";
		try {
			const size = fs.statSync(filePath).size;
			if (size > 0) {
				const start = Math.max(0, size - RELAY_TAIL_RESERVE_BYTES);
				const buffer = Buffer.alloc(size - start);
				const fd = fs.openSync(filePath, "r");
				try {
					fs.readSync(fd, buffer, 0, buffer.length, start);
				} finally {
					fs.closeSync(fd);
				}
				const text = buffer.toString("utf-8");
				const firstNewline = text.indexOf("\n");
				tail = firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
			}
		} catch {
			// Best-effort truncation; fall through to a bare reset.
		}
		const marker = JSON.stringify({ type: "relay_reset", key: stepKey, stepKey, ts: now() });
		try {
			fs.writeFileSync(filePath, `${marker}\n${tail}`, "utf-8");
			bytes = Buffer.byteLength(`${marker}\n${tail}`, "utf-8");
		} catch {
			// Best-effort; keep the stale byte count and continue appending.
		}
	};

	return {
		appendLine(line) {
			if (!line.trim()) return;
			appendChunk(line);
		},
		appendMarker(marker) {
			appendChunk(JSON.stringify({
				...marker,
				key: marker.key ?? stepKey,
				stepKey: marker.stepKey ?? stepKey,
				ts: marker.ts ?? now(),
			}));
		},
	};
}