/**
 * Main-view role selection for the child-conversation assembler.
 *
 * Closures over the shared `AssemblerState` (mutated by reference). Ports
 * InteractiveMode's `addMessageToChat` (user/assistant/custom/bashExecution
 * role selection), `renderSessionItems` assistant handling (toolCall
 * extraction + toolCall↔toolResult pairing by toolCallId), and the settings
 * re-application pass (setExpanded/setHideThinkingBlock/setOutputPad...).
 * `toolDefinition` stays undefined — the effective tool-definition registry
 * is private upstream; the native components render the honest generic
 * fallback (main-view parity).
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, BashExecutionComponent, CustomMessageComponent, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Spacer, Text } from "@earendil-works/pi-tui";
import { extractTextFromContent } from "../../shared/utils/messages.ts";
import { extractToolCalls, getUserMessageText, type AssemblerState, type RawMessage } from "./assembly-types.ts";
import { viewerMarkdownTheme } from "./viewer-settings.ts";

export interface MessageAssembler {
	addMessageToChat(message: RawMessage): void;
	assembleHistoryMessage(message: RawMessage): void;
	addToolComponent(toolCallId: string, toolName: string, args: Record<string, unknown>): ToolExecutionComponent;
	addUserMessage(text: string): void;
	addFallbackText(text: string): void;
	applySettings(settings: AssemblerState["settings"], toolOutputExpanded: boolean): void;
}

export function createMessageAssembler(state: AssemblerState): MessageAssembler {
	const markdownTheme = () => viewerMarkdownTheme(state.settings);

	const addToolComponent = (toolCallId: string, toolName: string, args: Record<string, unknown>): ToolExecutionComponent => {
		const component = new ToolExecutionComponent(toolName, toolCallId, args, {
			showImages: state.settings.showImages,
			imageWidthCells: state.settings.imageWidthCells,
		}, undefined /* toolDefinition generic — private upstream, honest fallback */, state.ui, state.cwd);
		component.setExpanded(state.toolOutputExpanded);
		state.container.addChild(component);
		state.pendingTools.set(toolCallId, component);
		return component;
	};

	const addUserMessage = (text: string): void => {
		if (!text) return;
		if (state.container.children.length > 0) state.container.addChild(new Spacer(1));
		state.container.addChild(new UserMessageComponent(text, markdownTheme(), state.settings.outputPad));
	};

	const addCustomMessage = (message: RawMessage): void => {
		// The main view only renders custom messages carrying `display`.
		if (!("display" in message)) return;
		const renderer = state.resolveCustomRenderer?.(message.customType);
		const component = new CustomMessageComponent(
			message as never,
			renderer as never,
			markdownTheme(),
			state.settings.outputPad,
		);
		component.setExpanded(state.toolOutputExpanded);
		state.container.addChild(component);
		if (!renderer) {
			// Explicit labeled generic fallback for unknown custom types.
			state.container.addChild(new Text("(generic fallback)", 1, 0));
		}
	};

	const addBashExecution = (message: RawMessage): void => {
		const component = new BashExecutionComponent(typeof message.command === "string" ? message.command : "", state.ui, message.excludeFromContext === true);
		if (typeof message.output === "string" && message.output) component.appendOutput(message.output);
		component.setComplete(
			typeof message.exitCode === "number" ? message.exitCode : undefined,
			message.cancelled === true,
			message.truncationResult !== undefined ? { truncated: true } : undefined,
			typeof message.fullOutputPath === "string" ? message.fullOutputPath : undefined,
		);
		state.container.addChild(component);
	};

	/** Main-view role selection for a single finalized message. */
	const addMessageToChat = (message: RawMessage): void => {
		switch (message.role) {
			case "user":
				addUserMessage(getUserMessageText(message));
				return;
			case "assistant":
				state.container.addChild(new AssistantMessageComponent(
					message as unknown as AssistantMessage,
					state.settings.hideThinkingBlock,
					markdownTheme(),
					state.settings.hiddenThinkingLabel,
					state.settings.outputPad,
				));
				return;
			case "custom":
				addCustomMessage(message);
				return;
			case "bashExecution":
				addBashExecution(message);
				return;
			case "toolResult":
				// Tool results render inline with their paired tool call.
				return;
			default: {
				// Unknown role: bounded text fallback, clearly labeled.
				const text = extractTextFromContent(message.content) || (typeof message.role === "string" ? message.role : "");
				if (text) {
					state.container.addChild(new Text(`(unlabeled message) ${text}`.trim(), 0, 0));
				}
			}
		}
	};

	/** renderSessionItems equivalent: assistant + toolCall components, paired
	 *  by toolCallId with the following toolResult messages. */
	const assembleHistoryMessage = (message: RawMessage): void => {
		if (message.role === "assistant") {
			addMessageToChat(message);
			for (const call of extractToolCalls(message.content)) {
				const component = addToolComponent(call.id, call.name, call.arguments);
				if (message.stopReason === "aborted" || message.stopReason === "error") {
					const error = message.stopReason === "aborted"
						? "Operation aborted"
						: message.errorMessage || "Error";
					component.updateResult({ content: [{ type: "text", text: error }], isError: true });
					state.pendingTools.delete(call.id);
				}
			}
			return;
		}
		if (message.role === "toolResult") {
			const component = state.pendingTools.get(message.toolCallId ?? "");
			if (component) {
				component.updateResult(message as unknown as ToolResultMessage);
				state.pendingTools.delete(message.toolCallId ?? "");
			}
			return;
		}
		addMessageToChat(message);
	};

	const addFallbackText = (text: string): void => {
		const trimmed = (text ?? "").trim();
		if (!trimmed) return;
		if (state.container.children.length > 0) state.container.addChild(new Spacer(1));
		state.container.addChild(new Text(trimmed, 0, 0));
	};

	const applySettings = (next: AssemblerState["settings"], nextExpanded: boolean): void => {
		state.settings = next;
		state.toolOutputExpanded = nextExpanded;
		for (const child of state.container.children) {
			if (child instanceof ToolExecutionComponent) {
				child.setExpanded(state.toolOutputExpanded);
				child.setShowImages(state.settings.showImages);
				child.setImageWidthCells(state.settings.imageWidthCells);
			} else if (child instanceof CustomMessageComponent) {
				child.setExpanded(state.toolOutputExpanded);
				child.setOutputPad(state.settings.outputPad);
			} else if (child instanceof BashExecutionComponent) {
				child.setExpanded(state.toolOutputExpanded);
			} else if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(state.settings.hideThinkingBlock);
				child.setHiddenThinkingLabel(state.settings.hiddenThinkingLabel);
				child.setOutputPad(state.settings.outputPad);
			} else if (child instanceof UserMessageComponent) {
				child.setOutputPad(state.settings.outputPad);
			}
		}
		state.container.invalidate();
	};

	return {
		addMessageToChat,
		assembleHistoryMessage,
		addToolComponent,
		addUserMessage,
		addFallbackText,
		applySettings,
	};
}