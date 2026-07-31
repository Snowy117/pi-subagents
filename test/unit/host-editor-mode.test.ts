import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createHostEditorConversation, HOST_EDITOR_WIDGET_KEY } from "../../src/tui/steer-view/host-editor-mode.ts";
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

function makeResident(overrides: Partial<PersistentRpcChild> = {}): PersistentRpcChild & { sent: Array<Record<string, unknown>>; resolveClosed: () => void; emitStdout: (text: string) => void } {
	const sent: Array<Record<string, unknown>> = [];
	const stdout = new EventEmitter() as never;
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
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
		proc: { stdout, exitCode: null } as never,
		write,
		sent,
		settled: true,
		lastActivityAt: 0,
		pendingDialogs: new Map(),
		pendingRequestIds: new Set(),
		closed,
		close: async () => {},
		resolveClosed,
		emitStdout: (text: string) => stdout.emit("data", Buffer.from(text)),
		...overrides,
	};
}

function fakeCtx() {
	const widgets = new Map<string, unknown>();
	const statuses = new Map<string, string | undefined>();
	return {
		hasUI: true,
		ui: {
			setWidget(key: string, content: unknown) {
				if (content === undefined) widgets.delete(key);
				else widgets.set(key, content);
			},
			setStatus(key: string, text: string | undefined) {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			requestRender() {},
		},
		widgets,
		statuses,
	};
}

function renderWidget(ctx: ReturnType<typeof fakeCtx>, width = 120): string[] {
	const factory = ctx.widgets.get(HOST_EDITOR_WIDGET_KEY) as
		| ((tui: unknown, theme: unknown) => { render(width: number): string[] })
		| undefined;
	assert.ok(factory, "widget must be mounted");
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	return factory(null, theme).render(width);
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
		resident.emitStdout(JSON.stringify({ id: "req", type: "response", command: "get_commands", success: true, data: { commands: [{ name: "dcp" }] } }) + "\n");
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
		resident.emitStdout(JSON.stringify({ id: "req", type: "response", command: "get_commands", success: true, data: { commands: [{ name: "dcp" }] } }) + "\n");
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
		resident.emitStdout(JSON.stringify({ type: "extension_ui_request", method: "notify", message: "DCP stats: 3 files" }) + "\n");
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

	it("shows the active child in the footer status while open and clears it on close", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ getResidentChild: () => resident });
		const ctx = fakeCtx();
		const target = makeTarget({ agent: "worker", runId: "run-1", index: 0, status: "running" });
		mode.open(ctx as never, target, resident);
		assert.ok(ctx.statuses.has(HOST_EDITOR_WIDGET_KEY), "status must be set while child mode is active");
		assert.ok(ctx.statuses.get(HOST_EDITOR_WIDGET_KEY)!.includes("worker"));
		assert.ok(ctx.statuses.get(HOST_EDITOR_WIDGET_KEY)!.includes("run-1:0"));
		mode.close(ctx as never);
		assert.equal(ctx.statuses.has(HOST_EDITOR_WIDGET_KEY), false, "status must be cleared on close");
	});

	it("auto-closes when the child process ends while the mode is active", async () => {
		const resident = makeResident();
		const notices: Array<{ message: string }> = [];
		const mode = createHostEditorConversation({
			getResidentChild: () => resident,
			notify: (message) => notices.push({ message }),
		});
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), resident);
		assert.equal(mode.active, true);
		resident.resolveClosed();
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(mode.active, false, "mode must auto-close when the child process exits");
		assert.ok(notices.some((n) => n.message.includes("process ended")));
		assert.equal(ctx.statuses.has(HOST_EDITOR_WIDGET_KEY), false, "status cleared after auto-close");
		// Input routing returns to the parent after auto-close.
		assert.equal(mode.routeInput({ type: "input", text: "hello" } as never).action, "continue");
	});

	it("auto-close removes the widget from the UI", async () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ getResidentChild: () => resident });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), resident);
		assert.ok(ctx.widgets.has(HOST_EDITOR_WIDGET_KEY), "widget must be mounted after open");
		mode.close(undefined);
		assert.equal(ctx.widgets.has(HOST_EDITOR_WIDGET_KEY), false, "widget must be removed after close(undefined)");
	});

	it("does not let a stale closed watcher close a newer conversation", async () => {
		const first = makeResident({ key: "run-1/0" });
		const second = makeResident({ key: "run-1/1" });
		const mode = createHostEditorConversation({ getResidentChild: () => second });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), first);
		mode.close(ctx as never);
		mode.open(ctx as never, makeTarget({ key: "foreground:run-1:1", index: 1 }), second);
		assert.equal(mode.active, true);
		first.resolveClosed(); // the previous resident dies after switch
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(mode.active, true, "a stale watcher must not close the active conversation");
	});

	it("auto-exits routed input when the child process is already gone", () => {
		const resident = makeResident();
		(resident.proc as { exitCode: number | null }).exitCode = 0;
		const notices: Array<{ message: string }> = [];
		const mode = createHostEditorConversation({
			getResidentChild: () => resident,
			notify: (message) => notices.push({ message }),
		});
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), resident);
		const result = mode.routeInput({ type: "input", text: "hello" } as never);
		assert.equal(result.action, "continue", "input must return to the parent for a dead child");
		assert.equal(mode.active, false, "mode must close instead of writing into a dead child");
		assert.equal(resident.sent.length, 0);
		assert.ok(notices.some((n) => n.message.includes("process ended")));
	});

	it("mounts a widget whose strip shows the child header and transcript history", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ getResidentChild: () => resident });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget({ agent: "worker", runId: "run-1", index: 0, status: "completed" }), resident);
		const lines = renderWidget(ctx);
		assert.ok(lines[0]!.includes("SUBAGENT") || lines[0]!.includes("worker"), "header line identifies the child");
		assert.ok(lines[0]!.includes("run-1:0"));
	});

	it("echoes submitted text into the widget strip", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ getResidentChild: () => resident });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), resident);
		mode.routeInput({ type: "input", text: "please explain", source: "interactive" } as never);
		const lines = renderWidget(ctx);
		assert.ok(lines.some((line) => line.includes("please explain")), "submitted text appears in the strip");
	});

	it("streams follow-up child responses into the widget strip", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ getResidentChild: () => resident });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), resident);
		resident.emitStdout(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Here is the answer." }] } }) + "\n");
		const lines = renderWidget(ctx);
		assert.ok(lines.some((line) => line.includes("Here is the answer.")));
		resident.emitStdout(JSON.stringify({ type: "tool_execution_start", toolName: "read" }) + "\n");
		const afterTool = renderWidget(ctx);
		assert.ok(afterTool.some((line) => line.includes("read")), "tool events stream into the strip");
	});

	it("does not duplicate the user's own echoed prompt in the strip", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ getResidentChild: () => resident });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), resident);
		// Submit echo first, then the child's own user-role echo must be skipped.
		mode.routeInput({ type: "input", text: "hello", source: "interactive" } as never);
		resident.emitStdout(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hello" }] } }) + "\n");
		resident.emitStdout(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi!" }] } }) + "\n");
		const lines = renderWidget(ctx);
		const youLines = lines.filter((line) => line.startsWith("You: hello"));
		assert.equal(youLines.length, 1, "user prompt must appear exactly once");
	});

	it("keeps the widget content stable across repeated renders (no self-erasure)", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ getResidentChild: () => resident });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), resident);
		mode.routeInput({ type: "input", text: "hello", source: "interactive" } as never);
		const first = renderWidget(ctx);
		const second = renderWidget(ctx);
		assert.equal(second.length, first.length, "widget must keep returning its content on every render");
		assert.ok(second.some((line) => line.includes("hello")));
	});
});
