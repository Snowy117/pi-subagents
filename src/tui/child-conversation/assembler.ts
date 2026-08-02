/**
 * Transport-agnostic child-conversation assembler (orchestrator layer).
 *
 * The assembler (this file) owns the streaming event handling and the public
 * API; role selection / pairing / settings live in `assemble-message.ts` over
 * the shared state from `assembly-types.ts`. Ports the main interactive view's
 * composition pipeline so a child conversation renders with the same native
 * components (and inherits the same realm prototype patches as the main
 * view), with toolCall↔toolResult pairing by toolCallId and per-pass settings
 * application. Callers seed it from transcript records (full Message objects)
 * and feed raw child RPC JSONL lines via addRpcLine.
 */

import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { createMessageAssembler } from "./assemble-message.ts";
import {
	asMessage,
	asRecord,
	createAssemblerState,
	extractToolCalls,
	getUserMessageText,
	type ChildConversationAssembler,
	type ChildConversationAssemblerOptions,
} from "./assembly-types.ts";
import { viewerMarkdownTheme } from "./viewer-settings.ts";

export type { ChildConversationAssembler, ChildConversationAssemblerOptions } from "./assembly-types.ts";

export function createChildConversationAssembler(options: ChildConversationAssemblerOptions): ChildConversationAssembler {
	const state = createAssemblerState(options);
	const { addMessageToChat, assembleHistoryMessage, addToolComponent, addUserMessage, addFallbackText, applySettings } = createMessageAssembler(state);

	return {
		get container() { return state.container; },
		seedTranscriptRecords(records) {
			for (const record of records) {
				if (record.recordType === "message" && record.role && record.message) {
					assembleHistoryMessage(asMessage(record.message));
					continue;
				}
				if (record.recordType === "truncated") {
					addFallbackText(record.text ?? "Transcript truncated.");
					continue;
				}
				if (record.recordType === "fallback" && record.text) {
					addFallbackText(record.text);
					continue;
				}
				// tool_start/tool_end bookkeeping records are covered by the
				// assistant message's toolCall content + toolResult messages.
			}
			state.lastSubmittedUserText = undefined;
		},
		submitUserText(text) {
			state.lastSubmittedUserText = text;
			addUserMessage(text);
		},
		addRpcLine(line) {
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch {
				return;
			}
			const record = asRecord(raw);
			switch (record.type) {
				case "message_start": {
					const message = asMessage(record.message);
					if (message.role === "assistant") {
						state.streamingComponent = new AssistantMessageComponent(
							undefined,
							state.settings.hideThinkingBlock,
							viewerMarkdownTheme(state.settings),
							state.settings.hiddenThinkingLabel,
							state.settings.outputPad,
						);
						state.container.addChild(state.streamingComponent);
						state.streamingComponent.updateContent(message as never);
						return;
					}
					if (message.role === "user") {
						// The child echoes the submitted prompt back as its own
						// user message; the submit echo already rendered it.
						const text = getUserMessageText(message);
						if (state.lastSubmittedUserText !== undefined && text === state.lastSubmittedUserText) {
							state.lastSubmittedUserText = undefined;
							return;
						}
						addMessageToChat(message);
						return;
					}
					addMessageToChat(message);
					return;
				}
				case "message_update": {
					if (!state.streamingComponent) return;
					const message = asMessage(record.message);
					if (message.role !== "assistant") return;
					state.streamingComponent.updateContent(message as never);
					for (const call of extractToolCalls(message.content)) {
						const existing = state.pendingTools.get(call.id);
						if (existing) {
							existing.updateArgs(call.arguments);
						} else {
							addToolComponent(call.id, call.name, call.arguments);
						}
					}
					return;
				}
				case "message_end": {
					if (!state.streamingComponent) {
						// Tolerate a lone message_end (no start observed): finalize
						// the complete message like history seeding would.
						const message = asMessage(record.message);
						if (message.role === "user") return;
						if (message.role === "assistant") assembleHistoryMessage(message);
						return;
					}
					const message = asMessage(record.message);
					if (message.role === "user") return;
					if (message.role !== "assistant") return;
					state.streamingComponent.updateContent(message as never);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						const error = message.stopReason === "aborted"
							? "Operation aborted"
							: message.errorMessage || "Error";
						for (const component of state.pendingTools.values()) {
							component.updateResult({ content: [{ type: "text", text: error }], isError: true });
						}
						state.pendingTools.clear();
					} else {
						for (const component of state.pendingTools.values()) {
							component.setArgsComplete();
						}
					}
					state.streamingComponent = undefined;
					return;
				}
				case "tool_execution_start": {
					const toolCallId = record.toolCallId ?? "";
					if (!toolCallId) return;
					const component = state.pendingTools.get(toolCallId)
						?? addToolComponent(toolCallId, record.toolName ?? "tool", asRecord(record).args as Record<string, unknown>);
					component.markExecutionStarted();
					return;
				}
				case "tool_execution_update": {
					const component = state.pendingTools.get(record.toolCallId ?? "");
					if (component && record.partialResult && typeof record.partialResult === "object") {
						component.updateResult({ ...(record.partialResult as { content?: unknown; details?: unknown }), isError: false }, true);
					}
					return;
				}
				case "tool_execution_end": {
					const component = state.pendingTools.get(record.toolCallId ?? "");
					if (component && record.result && typeof record.result === "object") {
						component.updateResult({ ...(record.result as { content?: unknown; details?: unknown }), isError: record.isError === true });
						state.pendingTools.delete(record.toolCallId ?? "");
					}
					return;
				}
				case "tool_result_end": {
					const message = asMessage(record.message);
					if (message.toolCallId) {
						const component = state.pendingTools.get(message.toolCallId);
						if (component) {
							component.updateResult(message as never);
							state.pendingTools.delete(message.toolCallId);
						}
					}
					return;
				}
				default:
					// Not an agent/message event: response records, extension UI
					// requests, agent_settled, queue/compaction state — ignored.
					return;
			}
		},
		applySettings,
		isStreaming() {
			return state.streamingComponent !== undefined;
		},
		pendingToolCount() {
			return state.pendingTools.size;
		},
		dispose() {
			state.container.clear();
			state.pendingTools.clear();
			state.streamingComponent = undefined;
			state.lastSubmittedUserText = undefined;
		},
	};
}