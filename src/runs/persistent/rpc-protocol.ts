/**
 * RPC child JSONL transport (Pi RPC protocol client side).
 *
 * Pi RPC is strict LF-only JSONL over child stdin/stdout. Node `readline` is
 * explicitly non-compliant because it also splits on U+2028/U+2029
 * (`docs/rpc.md:20-37`). This module owns the parent side of that framing:
 *
 * - a bounded write queue with `drain` backpressure on stdin;
 * - a line reader that splits on `\n` only and strips a trailing `\r`;
 * - request-id correlation for commands that expect a `response` record.
 */

import type { ChildProcess } from "node:child_process";

/** Maximum bytes buffered per child before writes are paused. */
const DEFAULT_WRITE_QUEUE_LIMIT = 256 * 1024;
/** Maximum length of a single inbound JSONL record (defensive cap). */
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

export interface RpcProtocolDeps {
	writeQueueLimit?: number;
	randomId?: () => string;
}

export interface RpcWrite {
	writeLine(line: string): boolean;
	write(command: Record<string, unknown>, id?: string): string;
	close(): void;
}

export interface RpcLineReader {
	onLine(handler: (line: string) => void): void;
	/** Resolve any buffered partial line; called before graceful shutdown. */
	flush(): void;
}

export interface RpcProtocol {
	write: RpcWrite;
	reader: RpcLineReader;
}

function defaultRandomId(): string {
	return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Create an LF-only JSONL writer bound to a child stdin stream.
 *
 * Backpressure: a false return from `stdin.write()` means the stream is
 * backpressured, but the chunk itself was accepted into the stream's internal
 * buffer; only subsequent lines must wait for `drain`. They are queued (up to
 * `writeQueueLimit` bytes) and flushed on the next `drain` event. `close()`
 * ends stdin — Pi treats stdin EOF as a graceful shutdown request that
 * persists the session.
 */
export function createRpcWrite(
	stdin: ChildProcess["stdin"],
	deps: RpcProtocolDeps = {},
): RpcWrite {
	const writeQueueLimit = deps.writeQueueLimit ?? DEFAULT_WRITE_QUEUE_LIMIT;
	const randomId = deps.randomId ?? defaultRandomId;
	if (!stdin) {
		return {
			writeLine() { return false; },
			write() { return ""; },
			close() {},
		};
	}
	// Writing to a dead child's stdin can throw ERR_STREAM_DESTROYED or emit
	// an unhandled EPIPE; swallow both so a routed input never crashes the host.
	stdin.on("error", () => {});

	let queue: string[] = [];
	let queueBytes = 0;
	let ended = false;
	let backpressured = false;
	let flushing = false;

	const safeWrite = (chunk: string): boolean => {
		try {
			return stdin.write(chunk);
		} catch {
			// The stream is destroyed/closed (child already gone); treat as
			// backpressure so queued lines are dropped on the next drain.
			return false;
		}
	};

	const flushQueue = (): void => {
		if (flushing) return;
		flushing = true;
		while (queue.length > 0) {
			const chunk = queue[0]!;
			const ok = safeWrite(chunk);
			if (!ok) break;
			queue.shift();
			queueBytes -= Buffer.byteLength(chunk, "utf-8");
		}
		flushing = false;
		if (queue.length === 0) backpressured = false;
	};
	// Single persistent listener; `once` per write would double-flush the queue.
	stdin.on("drain", flushQueue);
	return {
		writeLine(line: string): boolean {
			if (ended) return false;
			const chunk = `${line}\n`;
			const chunkBytes = Buffer.byteLength(chunk, "utf-8");
			if (queueBytes + chunkBytes > writeQueueLimit) return false;
			if (!backpressured && queue.length === 0) {
				const ok = safeWrite(chunk);
				if (ok) return true;
				// The chunk was accepted into the stream's internal buffer but
				// the stream is backpressured; queue subsequent lines only.
				backpressured = true;
				return true;
			}
			queue.push(chunk);
			queueBytes += chunkBytes;
			return true;
		},
		write(command: Record<string, unknown>, id?: string): string {
			const requestId = id ?? randomId();
			this.writeLine(JSON.stringify({ ...command, id: requestId }));
			return requestId;
		},
		close(): void {
			if (ended) return;
			ended = true;
			// Pi persists the session on stdin EOF; ending even with queued
			// content is safe because EOF still triggers graceful shutdown.
			try {
				stdin.end();
			} catch {
				// stdin may already be destroyed by the child exiting first.
			}
		},
	};
}

/**
 * Create an LF-only line reader over a child stdout (or stderr) stream.
 *
 * Splits on `\n` only; a trailing `\r` is stripped for `\r\n` tolerance, and
 * a partial final line is retained and flushed on demand. Individual records
 * larger than `MAX_RECORD_BYTES` are dropped (an empty line is emitted as a
 * placeholder) so a malformed record never stalls the parent.
 */
export function createRpcLineReader(
	stream: ChildProcess["stdout"] | ChildProcess["stderr"],
): RpcLineReader {
	let buffer = "";
	const handlers = new Set<(line: string) => void>();

	const emitLine = (line: string): void => {
		for (const handler of handlers) handler(line);
	};

	const onData = (chunk: Buffer | string): void => {
		buffer += chunk.toString();
		let newlineIndex: number;
		while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
			let line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (Buffer.byteLength(line, "utf-8") > MAX_RECORD_BYTES) {
				emitLine("");
				continue;
			}
			emitLine(line);
		}
		// A line with no newline yet can still grow unbounded across chunks.
		if (Buffer.byteLength(buffer, "utf-8") > MAX_RECORD_BYTES) {
			buffer = "";
			emitLine("");
		}
	};

	return {
		onLine(handler: (line: string) => void): void {
			handlers.add(handler);
			if (handlers.size === 1) stream.on("data", onData);
		},
		flush(): void {
			if (handlers.size === 0) return;
			if (buffer.length > 0) {
				const line = buffer;
				buffer = "";
				emitLine(line);
			}
		},
	};
}

export function attachRpcProtocol(
	child: ChildProcess,
	deps: RpcProtocolDeps = {},
): RpcProtocol {
	return {
		write: createRpcWrite(child.stdin, deps),
		reader: createRpcLineReader(child.stdout),
	};
}
