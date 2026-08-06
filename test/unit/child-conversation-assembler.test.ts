import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AssistantMessageComponent, BashExecutionComponent, CustomMessageComponent, ToolExecutionComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
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

function plainTerminalLine(line: string): string {
	return line.replace(/\x1b(?:\][^\x07]*\x07|\[[0-?]*[ -/]*[@-~])/g, "").trimEnd();
}

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

	it("does no historical work for an equal settings snapshot over a long transcript", () => {
		const setterSpies = [
			spyMethod(AssistantMessageComponent.prototype, "setHideThinkingBlock"),
			spyMethod(AssistantMessageComponent.prototype, "setHiddenThinkingLabel"),
			spyMethod(AssistantMessageComponent.prototype, "setOutputPad"),
			spyMethod(UserMessageComponent.prototype, "setOutputPad"),
			spyMethod(ToolExecutionComponent.prototype, "setExpanded"),
			spyMethod(ToolExecutionComponent.prototype, "setShowImages"),
			spyMethod(ToolExecutionComponent.prototype, "setImageWidthCells"),
			spyMethod(CustomMessageComponent.prototype, "setExpanded"),
			spyMethod(CustomMessageComponent.prototype, "setOutputPad"),
			spyMethod(BashExecutionComponent.prototype, "setExpanded"),
		];
		const invalidateSpy = spyMethod(Container.prototype, "invalidate");
		try {
			const assembler = makeAssembler();
			assembler.seedTranscriptRecords([
				...Array.from({ length: 1_000 }, (_, index) =>
					messageRecord(index % 2 === 0 ? "user" : "assistant", [{ type: "text", text: `message ${index}` }], { stopReason: "stop" })),
				messageRecord("assistant", [{ type: "toolCall", id: "equal-tool", name: "read", arguments: {} }], { stopReason: "toolUse" }),
				messageRecord("custom", [{ type: "text", text: "custom" }], { customType: "unknown", display: "custom" }),
				messageRecord("bashExecution", [], { command: "pwd", exitCode: 0 }),
			]);
			for (const spy of setterSpies) spy.calls.length = 0;
			invalidateSpy.calls.length = 0;
			assembler.applySettings(makeSettings(), false);
			assert.equal(setterSpies.reduce((total, spy) => total + spy.calls.length, 0), 0);
			assert.equal(invalidateSpy.calls.length, 0);
		} finally {
			invalidateSpy.restore();
			for (const spy of setterSpies.reverse()) spy.restore();
		}
	});

	it("propagates expansion changes only to expandable components", () => {
		const toolSpy = spyMethod(ToolExecutionComponent.prototype, "setExpanded");
		const customSpy = spyMethod(CustomMessageComponent.prototype, "setExpanded");
		const bashSpy = spyMethod(BashExecutionComponent.prototype, "setExpanded");
		const assistantSpy = spyMethod(AssistantMessageComponent.prototype, "setOutputPad");
		try {
			const assembler = makeAssembler();
			assembler.seedTranscriptRecords([
				messageRecord("assistant", [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], { stopReason: "toolUse" }),
				messageRecord("custom", [{ type: "text", text: "custom" }], { customType: "unknown", display: "custom" }),
				messageRecord("bashExecution", [], { command: "pwd", exitCode: 0 }),
			]);
			toolSpy.calls.length = 0;
			customSpy.calls.length = 0;
			bashSpy.calls.length = 0;
			assistantSpy.calls.length = 0;
			assembler.applySettings(makeSettings(), true);
			assert.equal(toolSpy.calls.length, 1);
			assert.equal(customSpy.calls.length, 1);
			assert.equal(bashSpy.calls.length, 1);
			assert.equal(assistantSpy.calls.length, 0);
		} finally {
			assistantSpy.restore();
			bashSpy.restore();
			customSpy.restore();
			toolSpy.restore();
		}
	});

	it("propagates output padding only to message components", () => {
		const assistantSpy = spyMethod(AssistantMessageComponent.prototype, "setOutputPad");
		const userSpy = spyMethod(UserMessageComponent.prototype, "setOutputPad");
		const customSpy = spyMethod(CustomMessageComponent.prototype, "setOutputPad");
		const toolSpy = spyMethod(ToolExecutionComponent.prototype, "setExpanded");
		try {
			const assembler = makeAssembler();
			assembler.seedTranscriptRecords([
				messageRecord("user", [userText]),
				messageRecord("assistant", [assembledText], { stopReason: "stop" }),
				messageRecord("custom", [{ type: "text", text: "custom" }], { customType: "unknown", display: "custom" }),
			]);
			assistantSpy.calls.length = 0;
			userSpy.calls.length = 0;
			customSpy.calls.length = 0;
			toolSpy.calls.length = 0;
			assembler.applySettings(makeSettings({ outputPad: 0 }), false);
			assert.equal(assistantSpy.calls.length, 1);
			assert.equal(userSpy.calls.length, 1);
			assert.equal(customSpy.calls.length, 1);
			assert.equal(toolSpy.calls.length, 0);
		} finally {
			toolSpy.restore();
			customSpy.restore();
			userSpy.restore();
			assistantSpy.restore();
		}
	});

	it("propagates thinking and image fields only to their native component classes", () => {
		const hideSpy = spyMethod(AssistantMessageComponent.prototype, "setHideThinkingBlock");
		const labelSpy = spyMethod(AssistantMessageComponent.prototype, "setHiddenThinkingLabel");
		const imagesSpy = spyMethod(ToolExecutionComponent.prototype, "setShowImages");
		const widthSpy = spyMethod(ToolExecutionComponent.prototype, "setImageWidthCells");
		try {
			const assembler = makeAssembler();
			assembler.seedTranscriptRecords([
				messageRecord("assistant", [assembledText, { type: "toolCall", id: "c1", name: "read", arguments: {} }], { stopReason: "toolUse" }),
			]);
			hideSpy.calls.length = 0;
			labelSpy.calls.length = 0;
			imagesSpy.calls.length = 0;
			widthSpy.calls.length = 0;
			assembler.applySettings(makeSettings({ hideThinkingBlock: true }), false);
			assert.equal(hideSpy.calls.length, 1);
			assert.equal(labelSpy.calls.length, 0);
			assert.equal(imagesSpy.calls.length, 0);
			assert.equal(widthSpy.calls.length, 0);

			assembler.applySettings(makeSettings({ hideThinkingBlock: true, hiddenThinkingLabel: "Hidden" }), false);
			assert.equal(labelSpy.calls.length, 1);
			assert.equal(imagesSpy.calls.length, 0);
			assert.equal(widthSpy.calls.length, 0);

			assembler.applySettings(makeSettings({ hideThinkingBlock: true, hiddenThinkingLabel: "Hidden", showImages: false }), false);
			assert.equal(imagesSpy.calls.length, 1);
			assert.equal(widthSpy.calls.length, 0);

			assembler.applySettings(makeSettings({ hideThinkingBlock: true, hiddenThinkingLabel: "Hidden", showImages: false, imageWidthCells: 42 }), false);
			assert.equal(imagesSpy.calls.length, 1);
			assert.equal(widthSpy.calls.length, 1);
		} finally {
			widthSpy.restore();
			imagesSpy.restore();
			labelSpy.restore();
			hideSpy.restore();
		}
	});

	it("rebuilds Markdown-bearing components through the shared theme when code block indentation changes", () => {
		const assembler = makeAssembler();
		assembler.seedTranscriptRecords([
			messageRecord("user", [{ type: "text", text: "```ts\nconst x = 1;\n```" }]),
			messageRecord("assistant", [{ type: "text", text: "```ts\nconst y = 2;\n```" }], { stopReason: "stop" }),
		]);
		assembler.applySettings(makeSettings({ codeBlockIndent: "    " }), false);
		const lines = assembler.container.render(80).map(plainTerminalLine);
		assert.ok(lines.find((line) => line.includes("const x"))?.startsWith("     const x"));
		assert.ok(lines.find((line) => line.includes("const y"))?.startsWith("     const y"));
	});

	it("uses the updated shared theme when code block indentation and output padding change together", () => {
		const assembler = makeAssembler();
		assembler.seedTranscriptRecords([
			messageRecord("user", [{ type: "text", text: "```ts\nconst combined = true;\n```" }]),
		]);
		assembler.applySettings(makeSettings({ codeBlockIndent: "    ", outputPad: 0 }), false);
		const codeLine = assembler.container.render(80).map(plainTerminalLine).find((line) => line.includes("const combined"));
		assert.ok(codeLine?.startsWith("    const combined"));
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
