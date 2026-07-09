/**
 * Output-file tail caching and human-readable last-activity text.
 */

import * as fs from "node:fs";

const outputTailCache = new Map<string, { mtime: number; size: number; lines: string[] }>();

/**
 * Get the last N lines from an output file (with mtime/size-based caching)
 */
function getOutputTail(outputFile: string | undefined, maxLines: number = 3): string[] {
	if (!outputFile) return [];
	let fd: number | null = null;
	try {
		const stat = fs.statSync(outputFile);
		if (stat.size === 0) return [];

		const cached = outputTailCache.get(outputFile);
		if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
			return cached.lines;
		}

		const tailBytes = 4096;
		const start = Math.max(0, stat.size - tailBytes);
		fd = fs.openSync(outputFile, "r");
		const buffer = Buffer.alloc(Math.min(tailBytes, stat.size));
		fs.readSync(fd, buffer, 0, buffer.length, start);
		const content = buffer.toString("utf-8");
		const allLines = content.split("\n").filter((l) => l.trim());
		const lines = allLines.slice(-maxLines).map((l) => l.slice(0, 120) + (l.length > 120 ? "..." : ""));

		outputTailCache.set(outputFile, { mtime: stat.mtimeMs, size: stat.size, lines });
		if (outputTailCache.size > 20) {
			const firstKey = outputTailCache.keys().next().value;
			if (firstKey) outputTailCache.delete(firstKey);
		}

		return lines;
	} catch {
		// Output tails are UI-only hints; unreadable or missing files should render as no tail.
		return [];
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				// Closing the best-effort tail file handle should not surface over the main status view.
			}
		}
	}
}

/**
 * Get human-readable last activity time for a file
 */
export function getLastActivity(outputFile: string | undefined): string {
	if (!outputFile) return "";
	try {
		const stat = fs.statSync(outputFile);
		const ago = Date.now() - stat.mtimeMs;
		if (ago < 1000) return "active now";
		if (ago < 60000) return `active ${Math.floor(ago / 1000)}s ago`;
		return `active ${Math.floor(ago / 60000)}m ago`;
	} catch {
		// Last-activity text is best effort; missing files should simply omit the hint.
		return "";
	}
}
