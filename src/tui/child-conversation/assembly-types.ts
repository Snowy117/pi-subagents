/**
 * Types, guards, and shared state for the child-conversation assembler.
 *
 * The assembler is split along a closure seam: this module owns the raw
 * record shapes (serialized Messages and RPC stdout records), the defensive
 * narrowing helpers, and the mutable assembly state object that
 * `assemble-message.ts` closures mutate by reference and `assembler.ts`
 * orchestrates.
 */

import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, type TUI } from "@earendil-works/pi-tui";
import type { ViewerSettings } from "./viewer-settings.ts";

/** A transcript record the assembler can seed from (subset of
 *  SteerTranscriptRecord; structurally compatible, keeps this module free of
 *  a steer-view dependency). */
export interface TranscriptSeedRecord {
	recordType: "message" | "tool_start" | "tool_end" | "truncated" | "fallback";
	ts: number;
	role?: string;
	text?: string;
	toolName?: string;
	message?: unknown;
}

/** Loose shape of the serialized Message persisted in child transcripts and
 *  relayed on RPC stdout; narrowed defensively before component construction. */
export interface RawMessage {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	customType?: string;
	display?: unknown;
	command?: string;
	output?: string;
	exitCode?: number;
	cancelled?: boolean;
	truncationResult?: unknown;
	fullOutputPath?: string;
	excludeFromContext?: boolean;
	isError?: boolean;
}

export interface RpcRecord {
	type?: string;
	message?: RawMessage;
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
}

export function asMessage(value: unknown): RawMessage {
	return (value && typeof value === "object" ? value : {}) as RawMessage;
}

export function asRecord(value: unknown): RpcRecord {
	return (value && typeof value === "object" ? value : {}) as RpcRecord;
}

/** Mirror of InteractiveMode.getUserMessageText: string content is used
 *  directly; array content contributes text blocks only. */
export function getUserMessageText(message: RawMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("");
}

export interface ToolCallBlock {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export function extractToolCalls(content: unknown): ToolCallBlock[] {
	if (!Array.isArray(content)) return [];
	const calls: ToolCallBlock[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const block = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
		if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
		const args = block.arguments && typeof block.arguments === "object"
			? block.arguments as Record<string, unknown>
			: {};
		calls.push({ id: block.id, name: block.name, arguments: args });
	}
	return calls;
}

export interface ChildConversationAssemblerOptions {
	ui: TUI;
	cwd: string;
	settings: ViewerSettings;
	toolOutputExpanded: boolean;
	/** Resolve a custom message renderer for customTypes the parent extension
	 *  itself registered. Unknown types return undefined and the assembler
	 *  renders the explicit generic fallback. */
	resolveCustomRenderer?: (customType: string | undefined) => unknown;
}

export interface ChildConversationAssembler {
	/** The composed component tree; render this inside the widget container. */
	readonly container: Container;
	seedTranscriptRecords(records: readonly TranscriptSeedRecord[]): void;
	/** Echo of the user's own submitted prompt (rendered before the child's
	 *  user-role echo arrives; the live echo is de-duplicated against it). */
	submitUserText(text: string): void;
	addRpcLine(line: string): void;
	applySettings(settings: ViewerSettings, toolOutputExpanded: boolean): void;
	isStreaming(): boolean;
	/** @internal count of unmatched toolCall components awaiting a result. */
	pendingToolCount(): number;
	dispose(): void;
}

/** Mutable assembly state shared by the message-assembly closures. */
export interface AssemblerState {
	container: Container;
	ui: TUI;
	cwd: string;
	resolveCustomRenderer: ((customType: string | undefined) => unknown) | undefined;
	settings: ViewerSettings;
	toolOutputExpanded: boolean;
	pendingTools: Map<string, ToolExecutionComponent>;
	streamingComponent: AssistantMessageComponent | undefined;
	lastSubmittedUserText: string | undefined;
}

export function createAssemblerState(options: ChildConversationAssemblerOptions): AssemblerState {
	return {
		container: new Container(),
		ui: options.ui,
		cwd: options.cwd,
		resolveCustomRenderer: options.resolveCustomRenderer,
		settings: options.settings,
		toolOutputExpanded: options.toolOutputExpanded,
		pendingTools: new Map(),
		streamingComponent: undefined,
		lastSubmittedUserText: undefined,
	};
}