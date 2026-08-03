import * as fs from "node:fs";
import * as path from "node:path";
import { LIVE_TRANSCRIPTS_DIR } from "../../shared/live-transcript.ts";
import { readContainedTextComplete, readContainedTextTail, readSessionTranscriptComplete, readSessionTranscriptTail } from "../../runs/background/fleet-view/transcript-tail.ts";
import type { SteerViewTarget } from "./target-model.ts";

export interface SteerTranscriptRecord {
	recordType: "message" | "tool_start" | "tool_end" | "truncated" | "fallback";
	ts: number;
	role?: string;
	text?: string;
	toolName?: string;
	argsPreview?: string;
	/** Full serialized Message object persisted by the transcript writer
	 *  (present on `message` records). The native assembler seeds its item
	 *  tree from these instead of the slim text projection. */
	message?: unknown;
}

export interface TranscriptTailPoll {
	records: SteerTranscriptRecord[];
	reset: boolean;
	warnings: string[];
}

type TranscriptTailFs = Pick<typeof fs, "closeSync" | "existsSync" | "lstatSync" | "openSync" | "readSync" | "realpathSync" | "statSync">;

export interface TranscriptTailOptions {
	trustedRoots: string[];
	fs?: TranscriptTailFs;
}

function pathWithin(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readablePath(filePath: string, roots: string[], fsImpl: TranscriptTailFs): { path?: string; warning?: string } {
	if (roots.length === 0 || !roots.some((root) => pathWithin(root, filePath))) {
		return { warning: `Refusing transcript path outside trusted roots: ${filePath}` };
	}
	try {
		const lstat = fsImpl.lstatSync(filePath);
		if (lstat.isSymbolicLink() || !lstat.isFile()) return { warning: `Refusing non-regular transcript path: ${filePath}` };
		const realPath = fsImpl.realpathSync(filePath);
		const realRoots = roots.filter((root) => fsImpl.existsSync(root)).map((root) => fsImpl.realpathSync(root));
		if (!realRoots.some((root) => pathWithin(root, realPath))) return { warning: `Refusing transcript path outside trusted roots: ${filePath}` };
		return { path: realPath };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		return { warning: error instanceof Error ? error.message : String(error) };
	}
}

function parseRecord(line: string): SteerTranscriptRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const ts = typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : 0;
	if (record.recordType === "truncated") {
		return { recordType: "truncated", ts, text: typeof record.message === "string" ? record.message : "Transcript truncated." };
	}
	if (record.recordType === "message") {
		if (typeof record.role !== "string") return undefined;
		const hasMessage = typeof record.message === "object" && record.message !== null;
		return {
			recordType: "message", ts, role: record.role,
			...(typeof record.text === "string" ? { text: record.text } : {}),
			...(hasMessage ? { message: record.message } : {}),
		};
	}
	if (record.recordType === "tool_start" || record.recordType === "tool_end") {
		return {
			recordType: record.recordType, ts,
			...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
			...(typeof record.argsPreview === "string" ? { argsPreview: record.argsPreview } : {}),
		};
	}
	return undefined;
}

export function createTranscriptTail(filePath: string, options: TranscriptTailOptions): { poll(): TranscriptTailPoll } {
	const fsImpl = options.fs ?? fs;
	let offset = 0;
	let partial = Buffer.alloc(0);
	let prefix = Buffer.alloc(0);
	let identity: string | undefined;
	return {
		poll(): TranscriptTailPoll {
			const safe = readablePath(filePath, options.trustedRoots, fsImpl);
			if (!safe.path) return { records: [], reset: false, warnings: safe.warning ? [safe.warning] : [] };
			let fd: number | undefined;
			try {
				const stat = fsImpl.statSync(safe.path);
				fd = fsImpl.openSync(safe.path, "r");
				const prefixLength = Math.min(stat.size, 256);
				const nextPrefix = Buffer.alloc(prefixLength);
				if (prefixLength > 0) fsImpl.readSync(fd, nextPrefix, 0, prefixLength, 0);
				const prefixChanged = prefix.length > 0
					&& (nextPrefix.length < prefix.length || !nextPrefix.subarray(0, prefix.length).equals(prefix));
				const nextIdentity = `${stat.dev}:${stat.ino}`;
				const reset = identity !== undefined && (identity !== nextIdentity || stat.size < offset || prefixChanged);
				if (identity === undefined || reset) {
					offset = 0;
					partial = Buffer.alloc(0);
				}
				identity = nextIdentity;
				prefix = nextPrefix;
				if (stat.size === offset) return { records: [], reset, warnings: [] };
				const length = stat.size - offset;
				const chunk = Buffer.alloc(length);
				const bytesRead = fsImpl.readSync(fd, chunk, 0, length, offset);
				offset += bytesRead;
				const combined = Buffer.concat([partial, chunk.subarray(0, bytesRead)]);
				const lines: string[] = [];
				let start = 0;
				for (let index = 0; index < combined.length; index++) {
					if (combined[index] !== 10) continue;
					lines.push(combined.subarray(start, index).toString("utf-8").replace(/\r$/, ""));
					start = index + 1;
				}
				partial = combined.subarray(start);
				let malformed = 0;
				const records = lines.flatMap((line) => {
					if (!line.trim()) return [];
					const parsed = parseRecord(line);
					if (!parsed) malformed++;
					return parsed ? [parsed] : [];
				});
				return { records, reset, warnings: malformed ? [`Skipped ${malformed} malformed transcript line${malformed === 1 ? "" : "s"}.`] : [] };
			} catch (error) {
				return { records: [], reset: false, warnings: [error instanceof Error ? error.message : String(error)] };
			} finally {
				if (fd !== undefined) fsImpl.closeSync(fd);
			}
		},
	};
}

export function trustedRootsForTarget(target: SteerViewTarget): string[] {
	return [...new Set([
		LIVE_TRANSCRIPTS_DIR,
		...(target.asyncDir ? [target.asyncDir] : []),
		...(target.trustedRoots ?? []),
	])];
}

export function readTranscriptFallback(target: SteerViewTarget, maxLines = 80): TranscriptTailPoll {
	const roots = trustedRootsForTarget(target);
	const complete = maxLines === Number.POSITIVE_INFINITY;
	if (target.outputFile) {
		const output = complete
			? readContainedTextComplete(target.outputFile, roots, "child output")
			: readContainedTextTail(target.outputFile, maxLines, roots, "child output");
		if (output.lines.length > 0) return { records: output.lines.map((text) => ({ recordType: "fallback", ts: 0, text })), reset: true, warnings: output.error ? [output.error] : [] };
	}
	if (target.recentOutput?.trim()) return { records: [{ recordType: "fallback", ts: 0, text: target.recentOutput }], reset: true, warnings: [] };
	if (target.sessionFile) {
		const session = complete
			? readSessionTranscriptComplete(target.sessionFile, roots)
			: readSessionTranscriptTail(target.sessionFile, maxLines, roots);
		return { records: session.lines.map((text) => ({ recordType: "fallback", ts: 0, text })), reset: true, warnings: session.warnings };
	}
	return { records: [], reset: false, warnings: [] };
}
