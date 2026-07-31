import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createHostEditorConversation } from "../../src/tui/steer-view/host-editor-mode.ts";
import type { PersistentRpcChild } from "../../src/runs/persistent/rpc-child-registry.ts";
import type { SteerViewTarget } from "../../src/tui/steer-view/target-model.ts";

function makeTarget(overrides: Partial<SteerViewTarget> = {}): SteerViewTarget {
	return {
		key: "foreground:run-1:0",
		kind: "foreground",
		runId: "run-1",
		index: 0,
		agent: "worker",
		status: "completed",
		active: false,
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeResident(): PersistentRpcChild & { sent: Array<Record<string, unknown>> } {
	const sent: Array<Record<string, unknown>> = [];
	const stdout = new EventEmitter() as never;
	const write = {
		writeLine: () => true,
		write: (command: Record<string, unknown>) => {
			sent.push(command);
			return "req";
		},
		close: () => {},
	};
	return {
		key: "run-1/0",
		proc: { stdout } as never,
		write,
		sent,
		settled: true,
		lastActivityAt: 0,
		pendingDialogs: new Map(),
		pendingRequestIds: new Set(),
		closed: new Promise(() => {}),
		close: async () => {},
	};
}

function fakeCtx() {
	const widgets = new Map<string, unknown>();
	return {
		hasUI: true,
		ui: {
			setWidget(key: string, content: unknown) {
				if (content === undefined) widgets.delete(key);
				else widgets.set(key, content);
			},
		},
		widgets,
	};
}

describe("host editor conversation mode", () => {
	it("stays inactive until opened with a resident child", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ getResidentChild: () => resident });
		const ctx = fakeCtx() as never;
		const target = makeTarget();
		assert.equal(mode.active, false);
		assert.equal(mode.routeInput({ type: "input", text: "hello" } as never).action, "continue");
		const opened = mode.open(ctx, target, resident);
		assert.equal(opened, true);
		assert.equal(mode.active, true);
		assert.equal(mode.targetKey, "foreground:run-1:0");
	});

	it("rejects opening without a resident child", () => {
		const mode = createHostEditorConversation({ getResidentChild: () => undefined });
		const opened = mode.open(fakeCtx() as never, makeTarget(), undefined);
		assert.equal(opened, false);
		assert.equal(mode.active, false);
	});

	it("routes ordinary text to the child and returns handled", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ getResidentChild: () => resident });
		mode.open(fakeCtx() as never, makeTarget(), resident);
		const result = mode.routeInput({ type: "input", text: "please explain", source: "interactive" } as never);
		assert.equal(result.action, "handled");
		assert.equal(resident.sent.length, 1);
		assert.equal(resident.sent[0]!.type, "prompt");
		assert.equal(resident.sent[0]!.message, "please explain");
	});

	it("routes //name to the child as a slash command, never to the parent", async () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ getResidentChild: () => resident });
		mode.open(fakeCtx() as never, makeTarget(), resident);
		const result = mode.routeInput({ type: "input", text: "//dcp stats", source: "interactive" } as never);
		assert.equal(result.action, "handled");
		// The get_commands request goes out first; the command executes once the
		// child reports it as available.
		assert.equal(resident.sent[0]!.type, "get_commands");
		(resident.proc as { stdout: EventEmitter }).stdout.emit("data", Buffer.from(
			JSON.stringify({ id: "req", type: "response", command: "get_commands", success: true, data: { commands: [{ name: "dcp" }] } }) + "\n",
		));
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(resident.sent.length, 2);
		assert.equal(resident.sent[1]!.type, "prompt");
		assert.equal(resident.sent[1]!.message, "/dcp stats");
	});

	it("rejects unknown //name commands with a visible notice, never a prompt", async () => {
		const resident = makeResident();
		const notices: Array<{ message: string; level?: string }> = [];
		const mode = createHostEditorConversation({
			getResidentChild: () => resident,
			notify: (message, level) => notices.push({ message, level }),
		});
		mode.open(fakeCtx() as never, makeTarget(), resident);
		mode.routeInput({ type: "input", text: "//ghost-command x", source: "interactive" } as never);
		(resident.proc as { stdout: EventEmitter }).stdout.emit("data", Buffer.from(
			JSON.stringify({ id: "req", type: "response", command: "get_commands", success: true, data: { commands: [{ name: "dcp" }] } }) + "\n",
		));
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(resident.sent.length, 1, "no prompt for an unknown child command");
		assert.ok(notices.some((n) => n.message.includes("/ghost-command") && n.message.includes("unavailable")));
	});

	it("re-sends get_commands after a timeout instead of caching an empty result", async () => {
		const resident = makeResident();
		const notices: Array<{ message: string; level?: string }> = [];
		const mode = createHostEditorConversation({
			getResidentChild: () => resident,
			notify: (message, level) => notices.push({ message, level }),
		});
		mode.open(fakeCtx() as never, makeTarget(), resident);
		// First //name triggers get_commands; no response arrives (timeout path).
		mode.routeInput({ type: "input", text: "//dcp", source: "interactive" } as never);
		assert.equal(resident.sent[0]!.type, "get_commands");
		await new Promise((resolve) => setTimeout(resolve, 2100));
		assert.ok(notices.some((n) => n.message.includes("/dcp") && n.message.includes("unavailable")), "timeout reports unavailable");
		// A later //name must re-request (empty timeout result is not cached).
		mode.routeInput({ type: "input", text: "//dcp stats", source: "interactive" } as never);
		const getCommandCount = resident.sent.filter((entry) => entry.type === "get_commands").length;
		assert.equal(getCommandCount, 2, "timeout must not poison the command cache");
	});

	it("relays child notify extension UI requests to the viewer", async () => {
		const resident = makeResident();
		const notices: Array<{ message: string; level?: string }> = [];
		const mode = createHostEditorConversation({
			getResidentChild: () => resident,
			notify: (message, level) => notices.push({ message, level }),
		});
		mode.open(fakeCtx() as never, makeTarget(), resident);
		(resident.proc as { stdout: EventEmitter }).stdout.emit("data", Buffer.from(
			JSON.stringify({ type: "extension_ui_request", method: "notify", message: "DCP stats: 3 files" }) + "\n",
		));
		assert.ok(notices.some((n) => n.message.includes("DCP stats")));
	});

	it("keeps single slash and !bash parent-owned", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ getResidentChild: () => resident });
		mode.open(fakeCtx() as never, makeTarget(), resident);
		assert.equal(mode.routeInput({ type: "input", text: "/help" } as never).action, "continue");
		assert.equal(mode.routeInput({ type: "input", text: "!bash ls" } as never).action, "continue");
		assert.equal(resident.sent.length, 0);
	});

	it("routes nothing after close", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ getResidentChild: () => resident });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), resident);
		mode.close(ctx as never);
		assert.equal(mode.active, false);
		assert.equal(mode.routeInput({ type: "input", text: "hello" } as never).action, "continue");
		assert.equal(resident.sent.length, 0);
	});
});
