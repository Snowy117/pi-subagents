import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_TRANSCRIPT_LINES = 80;
const MAX_TRANSCRIPT_LINES = 500;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

interface TextTailResult {
	path: string;
	lines: string[];
	truncated: boolean;
	error?: string;
}

export function transcriptLineLimit(value: number | undefined): number {
	if (value === undefined) return DEFAULT_TRANSCRIPT_LINES;
	if (!Number.isFinite(value)) return DEFAULT_TRANSCRIPT_LINES;
	return Math.max(1, Math.min(MAX_TRANSCRIPT_LINES, Math.trunc(value)));
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function readTextTail(filePath: string, maxLines: number): TextTailResult {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch (error) {
		if (isNotFoundError(error)) return { path: filePath, lines: [], truncated: false };
		return { path: filePath, lines: [], truncated: false, error: getErrorMessage(error) };
	}
	if (stat.size === 0) return { path: filePath, lines: [], truncated: false };

	let fd: number | undefined;
	try {
		const bytesToRead = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
		const start = stat.size - bytesToRead;
		const buffer = Buffer.alloc(bytesToRead);
		fd = fs.openSync(filePath, "r");
		const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
		const content = buffer.subarray(0, bytesRead).toString("utf-8");
		let lines = content.split(/\r?\n/);
		if (start > 0 && lines.length > 0) lines = lines.slice(1);
		if (lines.at(-1) === "") lines = lines.slice(0, -1);
		return { path: filePath, lines: lines.slice(-maxLines), truncated: start > 0 || lines.length > maxLines };
	} catch (error) {
		return { path: filePath, lines: [], truncated: false, error: getErrorMessage(error) };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

export function readContainedTextTail(filePath: string, maxLines: number, trustedRoots: string[], label: string): TextTailResult {
	if (trustedRoots.length === 0) return { path: filePath, lines: [], truncated: false, error: `Refusing to read ${label} transcript path without a trusted root: ${filePath}` };
	const resolvedPath = path.resolve(filePath);
	if (!trustedRoots.some((root) => pathWithin(root, resolvedPath))) {
		return { path: filePath, lines: [], truncated: false, error: `Refusing to read ${label} transcript path outside trusted roots: ${filePath}` };
	}
	let lstat: fs.Stats;
	try {
		lstat = fs.lstatSync(resolvedPath);
	} catch (error) {
		if (isNotFoundError(error)) return { path: filePath, lines: [], truncated: false };
		return { path: filePath, lines: [], truncated: false, error: getErrorMessage(error) };
	}
	if (lstat.isSymbolicLink()) return { path: filePath, lines: [], truncated: false, error: `Refusing to read symlink ${label} transcript path: ${filePath}` };
	if (!lstat.isFile()) return { path: filePath, lines: [], truncated: false, error: `Refusing to read non-file ${label} transcript path: ${filePath}` };
	let realPath: string;
	let realRoots: string[];
	try {
		realPath = fs.realpathSync(resolvedPath);
		realRoots = trustedRoots.filter((root) => fs.existsSync(root)).map((root) => fs.realpathSync(root));
	} catch (error) {
		return { path: filePath, lines: [], truncated: false, error: getErrorMessage(error) };
	}
	if (!realRoots.some((root) => pathWithin(root, realPath))) {
		return { path: filePath, lines: [], truncated: false, error: `Refusing to read ${label} transcript path outside trusted roots: ${filePath}` };
	}
	return readTextTail(resolvedPath, maxLines);
}

function stringifyJsonPreview(value: unknown, maxLength = 240): string {
	let raw: string;
	if (typeof value === "string") raw = value;
	else raw = JSON.stringify(value);
	return raw.length > maxLength ? `${raw.slice(0, maxLength)}…` : raw;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (!part || typeof part !== "object") return "";
		const entry = part as { type?: unknown; text?: unknown; name?: unknown; toolName?: unknown; args?: unknown; result?: unknown; content?: unknown };
		if (typeof entry.text === "string") return entry.text;
		if (entry.type === "toolCall" || entry.type === "tool_call") {
			const name = typeof entry.name === "string" ? entry.name : typeof entry.toolName === "string" ? entry.toolName : "tool";
			return `[tool: ${name}${entry.args === undefined ? "" : ` ${stringifyJsonPreview(entry.args)}`}]`;
		}
		if (entry.type === "toolResult" || entry.type === "tool_result") {
			return `[tool result${entry.result === undefined ? "" : `: ${stringifyJsonPreview(entry.result)}`}]`;
		}
		if (entry.content !== undefined) return stringifyJsonPreview(entry.content);
		return "";
	}).filter(Boolean).join("\n");
}

function sessionMessageLine(record: unknown): string | undefined {
	if (!record || typeof record !== "object") return undefined;
	const outer = record as { message?: unknown; role?: unknown; content?: unknown; type?: unknown };
	const message = outer.message && typeof outer.message === "object" ? outer.message as { role?: unknown; content?: unknown } : outer;
	const role = typeof message.role === "string" ? message.role : undefined;
	if (!role) return undefined;
	const text = contentText(message.content).trim();
	if (!text) return undefined;
	return `${role}: ${text}`;
}

export function readSessionTranscriptTail(sessionFile: string, maxLines: number, trustedRoots: string[]): { lines: string[]; warnings: string[] } {
	const tail = readContainedTextTail(sessionFile, Math.max(maxLines * 4, maxLines), trustedRoots, "session");
	const warnings: string[] = [];
	if (tail.error) warnings.push(`Session read failed for ${sessionFile}: ${tail.error}`);
	const lines: string[] = [];
	let malformed = 0;
	for (const line of tail.lines) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			const messageLine = sessionMessageLine(parsed);
			if (messageLine) lines.push(messageLine);
		} catch {
			malformed++;
		}
	}
	if (malformed > 0) warnings.push(`Skipped ${malformed} malformed session tail line${malformed === 1 ? "" : "s"}.`);
	return { lines: lines.slice(-maxLines), warnings };
}
