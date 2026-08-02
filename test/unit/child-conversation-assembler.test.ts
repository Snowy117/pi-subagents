import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AssistantMessageComponent, BashExecutionComponent, CustomMessageComponent, ToolExecutionComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createChildConversationAssembler } from "../../src/tui/child-conversation/assembler.ts";
import { VIEWER_SETTINGS_DEFAULTS } from "../../src/tui/child-conversation/viewer-settings.ts";

// Native components read the process-global theme at construction; pi calls
// initTheme at startup, unit tests must do the same before assembling.
initTheme();

const fakeUi = { requestRender() {} } as never;

function makeSettings(overrides: Record<string, unknown> = {}) {
	return { ...VIEWER_SETTINGS_DEFAULTS, ...overrides };
}

/** Wrap a prototype method with a spy (restored in finally). */
function spyMethod<T extends object, K extends keyof T>(prototype: T, method: K): { calls: Array<{ receiver: object; args: unknown[] }>; restore(): void } {
	const original = prototype[method];
	const calls: Array<{ receiver: object; args: unknown[] }> = [];
	(prototype[method] as unknown) = function (this: object, ...args: unknown[]) {
		calls.push({ receiver: this, args });
		return (original as (...callArgs: unknown[]) => unknown).call(this, ...args);
	};
	return {
		calls,
		restore() {
			(prototype[method] as unknown) = original;
		},
	};
}

function makeAssembler(overrides: Record<string, unknown> = {}) {
	return createChildConversationAssembler({
		ui: fakeUi,
		cwd: "/tmp",
		settings: makeSettings(overrides),
		toolOutputExpanded: false,
	});
}

function messageRecord(role: string, content: unknown, extra: Record<string, unknown> = {}) {
	return { recordType: "message" as const, ts: Date.now(), role, message: { role, content, ...extra } };
}

const userText = { type: "text", text: "hello there" };
const assembledText = { type: "text", text: "Let me check." };

describe("child conversation assembler", () => {
	it("renders user and assistant messages with the native components", () => {
		const assembler = makeAssembler();
		assembler.seedTranscriptRecords([
			messageRecord("user", [userText]),
			messageRecord("assistant", [assembledText], { stopReason: "stop" }),
		]);
		const children = assembler.container.children;
		assert.ok(children[0] instanceof UserMessageComponent, "user role selects UserMessageComponent");
		assert.equal(assembler.container.children.length, 2, "user + assistant");
		assert.ok(children[1] instanceof AssistantMessageComponent, "assistant role selects AssistantMessageComponent");
	});

	it("keeps user messages self-contained (no spacer before the first item)", () => {
		const assembler = makeAssembler();
		assembler.seedTranscriptRecords([messageRecord("user", [userText])]);
		const children = assembler.container.children;
		assert.equal(children.length, 1);
		assert.ok(children[0] instanceof UserMessageComponent);
	});

	it("pairs toolCall components with toolResult messages by toolCallId", () => {
		const assembler = makeAssembler();
		assembler.seedTranscriptRecords([
			messageRecord("user", [userText]),
			messageRecord("assistant", [
				assembledText,
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
			], { stopReason: "toolUse" }),
			messageRecord("toolResult", [{ type: "text", text: "file contents" }], {
				toolCallId: "call-1",
				toolName: "read",
				isError: false,
			}),
		]);
		assert.equal(assembler.pendingToolCount(), 0, "paired toolResult releases the pending component");
		const components = assembler.container.children.filter((child) => child instanceof ToolExecutionComponent);
		assert.equal(components.length, 1);
	});

	it("keeps unmatched toolCall components pending (like the main view)", () => {
		const assembler = makeAssembler();
		assembler.seedTranscriptRecords([
			messageRecord("user", [userText]),
			messageRecord("assistant", [{ type: "toolCall", id: "call-x", name: "bash", arguments: { command: "ls" } }], { stopReason: "toolUse" }),
		]);
		assert.equal(assembler.pendingToolCount(), 1);
	});

	it("renders error result for aborted/error assistant stop reasons", () => {
		const updateSpy = spyMethod(ToolExecutionComponent.prototype, "updateResult");
		try {
			const assembler = makeAssembler();
			assembler.seedTranscriptRecords([
				messageRecord("user", [userText]),
				messageRecord("assistant", [
					assembledText,
					{ type: "toolCall", id: "call-abort", name: "read", arguments: {} },
				], { stopReason: "error", errorMessage: "boom" }),
			]);
			assert.equal(assembler.pendingToolCount(), 0, "failed tool calls are resolved with an error");
			assert.ok(updateSpy.calls.length >= 1);
			const last = updateSpy.calls[updateSpy.calls.length - 1]!.args[0] as { content?: unknown; isError?: boolean };
			assert.equal(last.isError, true);
			assert.match(JSON.stringify(last.content ?? ""), /boom/);
		} finally {
			updateSpy.restore();
		}
	});

	it("renders custom messages with the explicit generic fallback label", () => {
		const assembler = makeAssembler();
		assembler.seedTranscriptRecords([messageRecord("custom", [{ type: "text", text: "custom body" }], { customType: "unknown-kind", display: "x" })]);
		const children = assembler.container.children;
		assert.ok(children.some((child) => child instanceof CustomMessageComponent), "custom role selects CustomMessageComponent");
		assert.ok(children.some((child) => child instanceof Text && ((child as Text).render(80)[0] ?? "").includes("generic fallback")), "unknown customType adds the labeled generic fallback");
	});

	it("renders bashExecution with BashExecutionComponent", () => {
		const assembler = makeAssembler();
		assembler.seedTranscriptRecords([messageRecord("bashExecution", [], { command: "ls -la", output: "a\nb", exitCode: 0 })]);
		assert.ok(assembler.container.children[0] instanceof BashExecutionComponent);
	});

	it("renders unknown roles as a labeled text fallback", () => {
		const assembler = makeAssembler();
		assembler.seedTranscriptRecords([messageRecord("weird-role", [{ type: "text", text: "odd payload" }])]);
		const text = assembler.container.children.find((child) => child instanceof Text) as Text | undefined;
		assert.ok(text, "unknown role falls back to Text");
		assert.match(text!.render(80)[0] ?? "", /weird-role|odd payload/);
	});

	it("renders truncated transcript records as labeled fallback text", () => {
		const assembler = makeAssembler();
		assembler.seedTranscriptRecords([{ recordType: "truncated", ts: 1, text: "Transcript truncated." }]);
		const text = assembler.container.children.find((child) => child instanceof Text) as Text | undefined;
		assert.ok(text);
		assert.match(text!.render(80)[0] ?? "", /Transcript truncated/);
	});

	it("flattens the streaming event sequence into one assistant turn", () => {
		const argsSpy = spyMethod(ToolExecutionComponent.prototype, "setArgsComplete");
		try {
			const assembler = makeAssembler();
			assembler.addRpcLine(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }));
			assert.equal(assembler.isStreaming(), true);
			assembler.addRpcLine(JSON.stringify({ type: "message_update", message: {
				role: "assistant",
				content: [assembledText, { type: "toolCall", id: "live-1", name: "read", arguments: { path: "x" } }],
			} }));
			assert.equal(assembler.pendingToolCount(), 1, "toolCall in message_update materializes a tool component");
			assembler.addRpcLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "live-1", toolName: "read", args: { path: "x" } }));
			assembler.addRpcLine(JSON.stringify({ type: "message_end", message: {
				role: "assistant",
				content: [assembledText, { type: "toolCall", id: "live-1", name: "read", arguments: { path: "x" } }],
				stopReason: "stop",
			} }));
			assert.equal(assembler.isStreaming(), false);
			assert.ok(argsSpy.calls.length >= 1, "completed stream finalizes pending tools with setArgsComplete");
			// tool_result_end pairs with the pending component.
			assembler.addRpcLine(JSON.stringify({ type: "tool_result_end", message: { role: "toolResult", toolCallId: "live-1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false } }));
			assert.equal(assembler.pendingToolCount(), 0);
		} finally {
			argsSpy.restore();
		}
	});

	it("marks aborted streams with an error result on pending tools", () => {
		const updateSpy = spyMethod(ToolExecutionComponent.prototype, "updateResult");
		try {
			const assembler = makeAssembler();
			assembler.addRpcLine(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }));
			assembler.addRpcLine(JSON.stringify({ type: "message_update", message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "abort-1", name: "bash", arguments: { command: "sleep 10" } }],
			} }));
			assembler.addRpcLine(JSON.stringify({ type: "message_end", message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "abort-1", name: "bash", arguments: { command: "sleep 10" } }],
				stopReason: "aborted",
			} }));
			assert.equal(assembler.pendingToolCount(), 0);
			const last = updateSpy.calls[updateSpy.calls.length - 1]!.args[0] as { isError?: boolean };
			assert.equal(last.isError, true);
		} finally {
			updateSpy.restore();
		}
	});

	it("tolerates a lone message_end without a preceding message_start", () => {
		const assembler = makeAssembler();
		assembler.addRpcLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [assembledText], stopReason: "stop" } }));
		assert.ok(assembler.container.children.some((child) => child instanceof AssistantMessageComponent));
	});

	it("de-duplicates the child's user-role echo against the submitted prompt", () => {
		const assembler = makeAssembler();
		assembler.submitUserText("hello");
		const before = assembler.container.children.length;
		assembler.addRpcLine(JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hello" }] } }));
		assert.equal(assembler.container.children.length, before, "the child's exact echo is skipped");
	});

	it("renders a different live user message after a submit echo", () => {
		const assembler = makeAssembler();
		assembler.submitUserText("hello");
		const before = assembler.container.children.length;
		assembler.addRpcLine(JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "a later question" }] } }));
		assert.equal(assembler.container.children.length, before + 2, "spacer + user component");
	});

	it("applies settings to existing components on each pass (setExpanded re-apply)", () => {
		const expandedSpy = spyMethod(ToolExecutionComponent.prototype, "setExpanded");
		try {
			const assembler = makeAssembler();
			assembler.seedTranscriptRecords([
				messageRecord("user", [userText]),
				messageRecord("assistant", [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], { stopReason: "toolUse" }),
			]);
			expandedSpy.calls.length = 0;
			assembler.applySettings(makeSettings(), true);
			assert.ok(expandedSpy.calls.length >= 1, "applySettings re-applies setExpanded on every tool component");
			assert.equal((expandedSpy.calls[expandedSpy.calls.length - 1]!.args[0] as boolean), true);
		} finally {
			expandedSpy.restore();
		}
	});

	it("is not streaming before any live assistant turn", () => {
		const assembler = makeAssembler();
		assembler.seedTranscriptRecords([messageRecord("user", [userText])]);
		assert.equal(assembler.isStreaming(), false);
	});

	it("ignores non-agent records (responses, elevator UI, settled)", () => {
		const assembler = makeAssembler();
		assembler.addRpcLine(JSON.stringify({ id: "r1", type: "response", command: "get_state", success: true, data: {} }));
		assembler.addRpcLine(JSON.stringify({ type: "extension_ui_request", method: "notify", message: "hi" }));
		assembler.addRpcLine(JSON.stringify({ type: "agent_settled" }));
		assembler.addRpcLine("not json at all");
		assert.equal(assembler.container.children.length, 0);
	});

	it("dispose clears the item tree and pending tools", () => {
		const assembler = makeAssembler();
		assembler.seedTranscriptRecords([messageRecord("assistant", [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], { stopReason: "toolUse" })]);
		assembler.dispose();
		assert.equal(assembler.container.children.length, 0);
		assert.equal(assembler.pendingToolCount(), 0);
	});
});