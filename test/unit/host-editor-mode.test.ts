import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createHostEditorConversation, HOST_EDITOR_WIDGET_KEY } from "../../src/tui/steer-view/host-editor-mode.ts";
import { createLocalRpcChannel, type ChildConversationChannel } from "../../src/tui/child-conversation/channel.ts";
import type { PersistentRpcChild } from "../../src/runs/persistent/rpc-child-registry.ts";
import type { SteerViewTarget } from "../../src/tui/steer-view/target-model.ts";

initTheme();

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

const makeChannel = (resident: PersistentRpcChild): ChildConversationChannel => createLocalRpcChannel(resident);

interface FakeChannel extends ChildConversationChannel {
	sent: Array<Record<string, unknown>>;
	emit(line: string): void;
	resolveClosed(): void;
	endConversationCalls: number;
}

/** Standalone fake channel (no real process) so tests can drive closed and
 *  endConversation without building a resident. */
function makeFakeChannel(overrides: Partial<FakeChannel> = {}): FakeChannel {
	const sent: Array<Record<string, unknown>> = [];
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
	const handlers = new Set<(line: string) => void>();
	const channel: FakeChannel = {
		key: "run-1/0",
		write(record, id) {
			sent.push({ ...record, ...(record.id ? {} : { id }) });
			return String(record.id ?? id ?? `req-${sent.length}`);
		},
		onStdoutLine(cb) {
			handlers.add(cb);
			return () => { handlers.delete(cb); };
		},
		settled: true,
		closed,
		touch() {},
		close: async () => { resolveClosed(); },
		sent,
		emit(line) {
			for (const handler of handlers) handler(line);
		},
		resolveClosed() { resolveClosed(); },
		endConversationCalls: 0,
		...overrides,
	};
	return channel;
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

function renderWidget(ctx: ReturnType<typeof fakeCtx>, tui: unknown = null, width = 120): string[] {
	const factory = ctx.widgets.get(HOST_EDITOR_WIDGET_KEY) as
		| ((tui: unknown, theme: unknown) => { render(width: number): string[] })
		| undefined;
	assert.ok(factory, "widget must be mounted");
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	return factory(tui, theme).render(width);
}

/** Mock TUI that records `requestRender` calls so tests can assert the widget
 *  repaint trigger without a real render loop. */
function makeMockTui(): { requestRenderCalls: number; requestRender(): void } {
	let requestRenderCalls = 0;
	return {
		get requestRenderCalls() {
			return requestRenderCalls;
		},
		requestRender() {
			requestRenderCalls++;
		},
	};
}

describe("host editor conversation mode", () => {
	it("stays inactive until opened with a channel", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx() as never;
		const target = makeTarget();
		assert.equal(mode.active, false);
		assert.equal(mode.routeInput({ type: "input", text: "hello" } as never).action, "continue");
		const opened = mode.open(ctx, target, makeChannel(resident));
		assert.equal(opened, true);
		assert.equal(mode.active, true);
		assert.equal(mode.targetKey, "foreground:run-1:0");
	});

	it("rejects opening without a channel", () => {
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const opened = mode.open(fakeCtx() as never, makeTarget(), undefined);
		assert.equal(opened, false);
		assert.equal(mode.active, false);
	});

	it("routes ordinary text to the child and returns handled", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		mode.open(fakeCtx() as never, makeTarget(), makeChannel(resident));
		const result = mode.routeInput({ type: "input", text: "please explain", source: "interactive" } as never);
		assert.equal(result.action, "handled");
		assert.equal(resident.sent.length, 1);
		assert.equal(resident.sent[0]!.type, "prompt");
		assert.equal(resident.sent[0]!.message, "please explain");
	});

	it("routes //name to the child as a slash command, never to the parent", async () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		mode.open(fakeCtx() as never, makeTarget(), makeChannel(resident));
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
			resolveChildChannel: async () => undefined,
			notify: (message, level) => notices.push({ message, level }),
		});
		mode.open(fakeCtx() as never, makeTarget(), makeChannel(resident));
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
			resolveChildChannel: async () => undefined,
			notify: (message, level) => notices.push({ message, level }),
		});
		mode.open(fakeCtx() as never, makeTarget(), makeChannel(resident));
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
			resolveChildChannel: async () => undefined,
			notify: (message, level) => notices.push({ message, level }),
		});
		mode.open(fakeCtx() as never, makeTarget(), makeChannel(resident));
		resident.emitStdout(JSON.stringify({ type: "extension_ui_request", method: "notify", message: "DCP stats: 3 files" }) + "\n");
		assert.ok(notices.some((n) => n.message.includes("DCP stats")));
	});

	it("keeps single slash and !bash parent-owned", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		mode.open(fakeCtx() as never, makeTarget(), makeChannel(resident));
		assert.equal(mode.routeInput({ type: "input", text: "/help" } as never).action, "continue");
		assert.equal(mode.routeInput({ type: "input", text: "!bash ls" } as never).action, "continue");
		assert.equal(resident.sent.length, 0);
	});

	it("routes nothing after close", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(resident));
		mode.close(ctx as never);
		assert.equal(mode.active, false);
		assert.equal(mode.routeInput({ type: "input", text: "hello" } as never).action, "continue");
		assert.equal(resident.sent.length, 0);
	});

	it("calls endConversation on the active channel when the mode closes", () => {
		const channel = makeFakeChannel();
		channel.endConversation = () => { channel.endConversationCalls++; };
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), channel);
		mode.close(undefined);
		assert.equal(channel.endConversationCalls, 1, "mode close must stop the viewer-side conversation session");
	});

	it("shows the active child in the footer status while open and clears it on close", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		const target = makeTarget({ agent: "worker", runId: "run-1", index: 0, status: "running" });
		mode.open(ctx as never, target, makeChannel(resident));
		assert.ok(ctx.statuses.has(HOST_EDITOR_WIDGET_KEY), "status must be set while child mode is active");
		assert.ok(ctx.statuses.get(HOST_EDITOR_WIDGET_KEY)!.includes("worker"));
		assert.ok(ctx.statuses.get(HOST_EDITOR_WIDGET_KEY)!.includes("run-1:0"));
		mode.close(ctx as never);
		assert.equal(ctx.statuses.has(HOST_EDITOR_WIDGET_KEY), false, "status must be cleared on close");
	});

	it("auto-closes when the child process ends while the mode is active and no reopen is possible", async () => {
		const resident = makeResident();
		const notices: Array<{ message: string }> = [];
		const mode = createHostEditorConversation({
			resolveChildChannel: async () => undefined,
			notify: (message) => notices.push({ message }),
		});
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(resident));
		assert.equal(mode.active, true);
		resident.resolveClosed();
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(mode.active, false, "mode must auto-close when the child process exits and nothing can be reopened");
		assert.ok(notices.some((n) => n.message.includes("process ended")));
		assert.equal(ctx.statuses.has(HOST_EDITOR_WIDGET_KEY), false, "status cleared after auto-close");
		// Input routing returns to the parent after auto-close.
		assert.equal(mode.routeInput({ type: "input", text: "hello" } as never).action, "continue");
	});

	it("stops re-resolving when a reopened channel dies instantly (no reopen loop)", async () => {
		const first = makeFakeChannel();
		const reopened = makeFakeChannel();
		let resolverCalls = 0;
		const notices: Array<{ message: string }> = [];
		const mode = createHostEditorConversation({
			resolveChildChannel: async () => {
				resolverCalls++;
				return reopened;
			},
			notify: (message) => notices.push({ message }),
		});
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), first);
		first.resolveClosed();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(mode.active, true, "first swap succeeds");
		assert.equal(resolverCalls, 1);
		// The reopened channel dies within the swap-rate window: the mode must
		// close instead of resolving (and spawning) again.
		reopened.resolveClosed();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(mode.active, false, "a second immediate death must close the mode");
		assert.equal(resolverCalls, 1, "no further re-resolve/spawn after an instant-death reopen");
		assert.ok(notices.some((n) => n.message.includes("process ended")));
	});

	it("swaps to a reopened channel when the active channel closes, preserving the conversation", async () => {
		const first = makeResident();
		const reopened = makeResident({ key: "run-1/0" });
		const notices: Array<{ message: string }> = [];
		const mode = createHostEditorConversation({
			resolveChildChannel: async () => makeChannel(reopened),
			notify: (message) => notices.push({ message }),
		});
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(first));
		mode.routeInput({ type: "input", text: "hello", source: "interactive" } as never);
		assert.equal(first.sent.length, 1);
		first.resolveClosed();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(mode.active, true, "mode must stay active after a seamless channel swap");
		assert.ok(notices.some((n) => n.message.includes("resumed")));
		// New submissions route to the reopened channel, not the dead one.
		mode.routeInput({ type: "input", text: "again", source: "interactive" } as never);
		assert.equal(first.sent.length, 1, "the dead channel must not receive further writes");
		assert.equal(reopened.sent.length, 1, "the reopened channel receives the follow-up");
		assert.equal(reopened.sent[0]!.message, "again");
		// The accumulated conversation (before and after the swap) is intact.
		const lines = renderWidget(ctx);
		assert.ok(lines.some((line) => line.includes("hello")), "pre-swap user text survives the swap");
		assert.ok(lines.some((line) => line.includes("again")), "post-swap user text renders");
	});

	it("streams live lines from the swapped channel into the same widget", async () => {
		const first = makeResident();
		const reopened = makeResident({ key: "run-1/0" });
		const mode = createHostEditorConversation({
			resolveChildChannel: async () => makeChannel(reopened),
		});
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(first));
		first.resolveClosed();
		await new Promise((resolve) => setTimeout(resolve, 20));
		reopened.emitStdout(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Answer after reopen." }], stopReason: "stop" } }) + "\n");
		const lines = renderWidget(ctx);
		assert.ok(lines.some((line) => line.includes("Answer after reopen.")), "assistant output from the reopened channel renders in the widget");
	});

	it("does not swap when a stale closed watcher fires for a previous channel", async () => {
		const first = makeFakeChannel({ key: "run-1/0" });
		const second = makeFakeChannel({ key: "run-1/1" });
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), first);
		mode.close(ctx as never);
		mode.open(ctx as never, makeTarget({ key: "foreground:run-1:1", index: 1 }), second);
		assert.equal(mode.active, true);
		first.resolveClosed(); // the previous channel dies after switch
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(mode.targetKey, "foreground:run-1:1", "a stale watcher must not swap or close the active conversation");
		assert.equal(mode.active, true);
	});

	it("auto-close removes the widget from the UI", async () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(resident));
		assert.ok(ctx.widgets.has(HOST_EDITOR_WIDGET_KEY), "widget must be mounted after open");
		mode.close(undefined);
		assert.equal(ctx.widgets.has(HOST_EDITOR_WIDGET_KEY), false, "widget must be removed after close(undefined)");
	});

	it("does not let a stale closed watcher close a newer conversation", async () => {
		const first = makeResident({ key: "run-1/0" });
		const second = makeResident({ key: "run-1/1" });
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(first));
		mode.close(ctx as never);
		mode.open(ctx as never, makeTarget({ key: "foreground:run-1:1", index: 1 }), makeChannel(second));
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
			resolveChildChannel: async () => undefined,
			notify: (message) => notices.push({ message }),
		});
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(resident));
		const result = mode.routeInput({ type: "input", text: "hello" } as never);
		assert.equal(result.action, "continue", "input must return to the parent for a dead child");
		assert.equal(mode.active, false, "mode must close instead of writing into a dead child");
		assert.equal(resident.sent.length, 0);
		assert.ok(notices.some((n) => n.message.includes("process ended")));
	});

	it("mounts a widget whose strip shows the child header and transcript history", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget({ agent: "worker", runId: "run-1", index: 0, status: "completed" }), makeChannel(resident));
		const lines = renderWidget(ctx);
		assert.ok(lines[0]!.includes("SUBAGENT") || lines[0]!.includes("worker"), "header line identifies the child");
		assert.ok(lines[0]!.includes("run-1:0"));
	});

	it("echoes submitted text into the widget strip", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(resident));
		mode.routeInput({ type: "input", text: "please explain", source: "interactive" } as never);
		const lines = renderWidget(ctx);
		assert.ok(lines.some((line) => line.includes("please explain")), "submitted text appears in the strip");
	});

	it("streams follow-up child responses into the widget strip", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(resident));
		resident.emitStdout(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Here is" }] } }) + "\n");
		const midStream = renderWidget(ctx);
		assert.ok(midStream.some((line) => line.includes("Here is")), "partial assistant text renders mid-stream");
		resident.emitStdout(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Here is the answer." }] } }) + "\n");
		const afterUpdate = renderWidget(ctx);
		assert.ok(afterUpdate.some((line) => line.includes("Here is the answer.")), "assistant text streams into the widget");
		assert.notDeepEqual(afterUpdate, midStream, "the widget content changes as tokens arrive, without user input");
		resident.emitStdout(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Here is the answer." }], stopReason: "stop" } }) + "\n");
		const afterEnd = renderWidget(ctx);
		assert.ok(afterEnd.some((line) => line.includes("Here is the answer.")), "finalized assistant message renders");
		resident.emitStdout(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} }) + "\n");
		const afterTool = renderWidget(ctx);
		assert.ok(afterTool.some((line) => line.includes("read")), "tool events stream into the widget");
		assert.notDeepEqual(afterTool, afterEnd, "tool events change the widget content");
	});

	it("uses the mounted TUI for native tool updates and monotonically repaints streamed RPC lines", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(resident));
		const tui = makeMockTui();
		renderWidget(ctx, tui); // mount the widget; the factory captures the tui handle
		assert.equal(tui.requestRenderCalls, 0);
		let previous = tui.requestRenderCalls;
		resident.emitStdout(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } }) + "\n");
		assert.ok(tui.requestRenderCalls > previous);
		previous = tui.requestRenderCalls;
		resident.emitStdout(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [
			{ type: "text", text: "Hello" },
			{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
		] } }) + "\n");
		assert.ok(tui.requestRenderCalls > previous);
		previous = tui.requestRenderCalls;
		assert.doesNotThrow(() => {
			resident.emitStdout(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [
				{ type: "text", text: "Hello" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
			], stopReason: "tool_use" } }) + "\n");
		}, "ToolExecutionComponent.setArgsComplete must receive a requestRender-capable TUI");
		assert.ok(tui.requestRenderCalls > previous);
		previous = tui.requestRenderCalls;
		resident.emitStdout(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} }) + "\n");
		assert.ok(tui.requestRenderCalls > previous);
		previous = tui.requestRenderCalls;
		resident.emitStdout(JSON.stringify({ type: "tool_execution_update", toolCallId: "tool-1", partialResult: { content: [{ type: "text", text: "partial" }] } }) + "\n");
		assert.ok(tui.requestRenderCalls > previous, "tool execution updates also repaint the widget");
		const lines = renderWidget(ctx, tui);
		assert.ok(lines.some((line) => line.includes("Hello")), "the streamed content is visible in the widget");
	});

	it("requests a render for response and extension_ui_request lines (R1)", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(resident));
		const tui = makeMockTui();
		renderWidget(ctx, tui);
		resident.emitStdout(JSON.stringify({ type: "response", id: "req-1", command: "get_commands", success: true, data: { commands: [] } }) + "\n");
		assert.equal(tui.requestRenderCalls, 1, "plain response lines repaint the widget");
		resident.emitStdout(JSON.stringify({ type: "extension_ui_request", method: "notify", message: "note" }) + "\n");
		assert.equal(tui.requestRenderCalls, 2, "extension_ui_request notify lines repaint the widget");
	});

	it("stops requesting renders after close (R1 cleanup)", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(resident));
		const tui = makeMockTui();
		renderWidget(ctx, tui);
		resident.emitStdout(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "x" }] } }) + "\n");
		assert.equal(tui.requestRenderCalls, 1);
		mode.close(ctx as never);
		resident.emitStdout(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "y" }], stopReason: "stop" } }) + "\n");
		assert.equal(tui.requestRenderCalls, 1, "no renders after the mode closes");
	});

	it("does not duplicate the user's own echoed prompt in the strip", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(resident));
		// Submit echo first, then the child's own user-role echo must be skipped.
		mode.routeInput({ type: "input", text: "hello", source: "interactive" } as never);
		resident.emitStdout(JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hello" }] } }) + "\n");
		resident.emitStdout(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi!" }], stopReason: "stop" } }) + "\n");
		const lines = renderWidget(ctx);
		const helloLines = lines.filter((line) => line.includes("hello"));
		assert.equal(helloLines.length, 1, "user prompt must appear exactly once");
	});

	it("keeps the widget content stable across repeated renders (no self-erasure)", () => {
		const resident = makeResident();
		const mode = createHostEditorConversation({ resolveChildChannel: async () => undefined });
		const ctx = fakeCtx();
		mode.open(ctx as never, makeTarget(), makeChannel(resident));
		mode.routeInput({ type: "input", text: "hello", source: "interactive" } as never);
		const first = renderWidget(ctx);
		const second = renderWidget(ctx);
		assert.equal(second.length, first.length, "widget must keep returning its content on every render");
		assert.ok(second.some((line) => line.includes("hello")));
	});
});
