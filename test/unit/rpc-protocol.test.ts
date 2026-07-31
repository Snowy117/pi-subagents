import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createRpcLineReader, createRpcWrite } from "../../src/runs/persistent/rpc-protocol.ts";

/** Minimal writable stream shape for the stdin pipe. */
class FakeStdin extends EventEmitter {
	written = "";
	ended = false;
	drained = false;
	write(chunk: string): boolean {
		this.written += chunk;
		const ok = this.drained;
		this.drained = false;
		return ok;
	}
	end(): void {
		this.ended = true;
	}
}

/** Minimal readable stream shape for stdout. */
class FakeStdout extends EventEmitter {
	push(chunk: string): void {
		this.emit("data", Buffer.from(chunk));
	}
	end(): void {
		this.emit("end");
	}
}

describe("createRpcWrite", () => {
	it("writes LF-terminated JSON lines", () => {
		const stdin = new FakeStdin();
		stdin.drained = true;
		const write = createRpcWrite(stdin as never, { randomId: () => "req-1" });
		const id = write.write({ type: "prompt", message: "hi" });
		assert.equal(id, "req-1");
		assert.equal(stdin.written, '{"type":"prompt","message":"hi","id":"req-1"}\n');
	});

	it("queues subsequent lines on backpressure and flushes on drain", () => {
		const stdin = new FakeStdin();
		stdin.drained = false; // first write returns false
		const write = createRpcWrite(stdin as never);
		// The chunk that returned false was accepted into the stream's internal
		// buffer; only later lines are queued until drain.
		write.writeLine('{"a":1}');
		assert.equal(stdin.written, '{"a":1}\n');
		write.writeLine('{"a":2}');
		assert.equal(stdin.written, '{"a":1}\n'); // second line still queued
		stdin.drained = true;
		stdin.emit("drain");
		assert.equal(stdin.written, '{"a":1}\n{"a":2}\n');
	});

	it("stops accepting writes after close", () => {
		const stdin = new FakeStdin();
		stdin.drained = true;
		const write = createRpcWrite(stdin as never);
		write.close();
		assert.equal(stdin.ended, true);
		assert.equal(write.writeLine('{"a":1}'), false);
	});

	it("drops writes when no stdin is available", () => {
		const write = createRpcWrite(null as never);
		assert.equal(write.writeLine('{"a":1}'), false);
		assert.equal(write.write({ type: "prompt", message: "x" }), "");
		write.close();
	});
});

describe("createRpcLineReader", () => {
	it("splits records on LF only", () => {
		const stdout = new FakeStdout();
		const reader = createRpcLineReader(stdout as never);
		const lines: string[] = [];
		reader.onLine((line) => lines.push(line));
		// U+2028 inside a JSON string must NOT split the record.
		stdout.push('{"text":"a\u2028b"}\n{"type":"agent_settled"}\n');
		assert.deepEqual(lines, ['{"text":"a\u2028b"}', '{"type":"agent_settled"}']);
	});

	it("strips a trailing carriage return for \\r\\n tolerance", () => {
		const stdout = new FakeStdout();
		const reader = createRpcLineReader(stdout as never);
		const lines: string[] = [];
		reader.onLine((line) => lines.push(line));
		stdout.push('{"a":1}\r\n');
		assert.deepEqual(lines, ['{"a":1}']);
	});

	it("handles fragmented chunks and flushes a partial final line", () => {
		const stdout = new FakeStdout();
		const reader = createRpcLineReader(stdout as never);
		const lines: string[] = [];
		reader.onLine((line) => lines.push(line));
		stdout.push('{"a":');
		stdout.push('1}\n{"b":2}');
		reader.flush();
		assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
	});

	it("drops a runaway oversized record without stalling", () => {
		const stdout = new FakeStdout();
		const reader = createRpcLineReader(stdout as never);
		const lines: string[] = [];
		reader.onLine((line) => lines.push(line));
		const huge = "x".repeat(20 * 1024 * 1024);
		stdout.push(`${huge}\n{"ok":true}\n`);
		reader.flush();
		assert.deepEqual(lines, ["", '{"ok":true}']);
	});
});
