/**
 * Host-editor routing mode for direct child conversation (Option B).
 *
 * When active, the real Pi editor stays mounted and focused; a full-height
 * widget (built from the native child-conversation assembler) is mounted
 * above it via `ctx.ui.setWidget()`, and ordinary editor submissions are
 * routed to the selected child's resident RPC process through the
 * `pi.on("input")` handler, which returns `{ action: "handled" }` so the
 * parent agent never sees the message.
 *
 * Slash ownership:
 * - single `/` (built-in/extension/skill/template) → parent (`continue`);
 * - `!bash` → parent (`continue`);
 * - `//name args` → selected child RPC command, validated against the child's
 *   `get_commands` list (never falls through to a child LLM prompt);
 * - ordinary text → selected child RPC prompt (images forwarded).
 *
 * The conversation surface is a transport-agnostic assembler
 * (src/tui/child-conversation/) seeded from the child transcript (full
 * Message objects) and fed live RPC stdout lines, rendering with the same
 * native components as the main view. Child `extension_ui_request` notify
 * records are relayed as viewer notices.
 */

import type { ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createLocalRpcChannel, type ChildConversationChannel } from "../child-conversation/channel.ts";
import { createChildConversationAssembler, type ChildConversationAssembler } from "../child-conversation/assembler.ts";
import { createChildConversationWidget } from "../child-conversation/render.ts";
import { createViewerSettingsReader } from "../child-conversation/viewer-settings.ts";
import { createChildCommandValidator, type ChildCommandValidator } from "./child-commands.ts";
import { createTranscriptTail, readTranscriptFallback, trustedRootsForTarget, type SteerTranscriptRecord } from "./transcript-tail.ts";
import type { SteerViewTarget } from "./target-model.ts";
import type { ResolveChildChannel } from "./child-channel.ts";

export const HOST_EDITOR_WIDGET_KEY = "subagents-child-conversation";

export interface HostEditorConversationHandle {
	readonly active: boolean;
	readonly targetKey: string | undefined;
	open(ctx: ExtensionContext, target: SteerViewTarget, channel: ChildConversationChannel | undefined): boolean;
	close(ctx: ExtensionContext | undefined): void;
	routeInput(input: InputEvent): InputEventResult;
	isStreaming(): boolean;
	getActiveChannel(): ChildConversationChannel | undefined;
	getUiContext(): ExtensionContext | undefined;
	toggleToolExpansion(): void;
	toggleThinkingHidden(): void;
	dispose(): void;
}

interface HostEditorModeOptions {
	/** Re-resolve the child channel when the active one closes (reopen path). */
	resolveChildChannel: ResolveChildChannel;
	notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

function statusLine(target: SteerViewTarget): string {
	return `subagent: ${target.agent} · ${target.runId}:${target.index} · ${target.status}`;
}

export function createHostEditorConversation(options: HostEditorModeOptions): HostEditorConversationHandle {
	const { resolveChildChannel, notify } = options;
	let active = false;
	let disposed = false;
	let currentTarget: SteerViewTarget | undefined;
	let currentChannel: ChildConversationChannel | undefined;
	let lastCtx: ExtensionContext | undefined;
	let widgetMounted = false;
	let unsubscribeStdout: (() => void) | undefined;
	let assembler: ChildConversationAssembler | undefined;
	let settingsReader: ReturnType<typeof createViewerSettingsReader> | undefined;
	let commandValidator: ChildCommandValidator | undefined;
	/** True from the first routed prompt until agent_settled; complements the
	 *  assembler's streaming component (covers the pre-stream window). */
	let turnActive = false;
	let toolsExpandedOverride: boolean | undefined;
	let hideThinkingOverride: boolean | undefined;

	const currentExpanded = (): boolean => {
		try {
			const ui = lastCtx?.ui;
			return typeof ui?.getToolsExpanded === "function" ? ui.getToolsExpanded() : false;
		} catch {
			// A stale UI context must not break the settings pass.
			return false;
		}
	};

	const applySettingsPass = (): void => {
		if (!assembler || !settingsReader) return;
		const settings = settingsReader.read();
		const effective = hideThinkingOverride === undefined
			? settings
			: { ...settings, hideThinkingBlock: hideThinkingOverride };
		assembler.applySettings(effective, toolsExpandedOverride ?? currentExpanded());
	};

	const ensureWidget = (ctx: ExtensionContext): void => {
		if (widgetMounted || !ctx.hasUI || !assembler) return;
		widgetMounted = true;
		const baseFactory = createChildConversationWidget({
			assembler,
			statusLine: () => (currentTarget ? statusLine(currentTarget) : "subagent: (none)"),
		});
		ctx.ui.setWidget(HOST_EDITOR_WIDGET_KEY, (tui, theme) => {
			const component = baseFactory(tui, theme);
			const render = component.render;
			component.render = (width: number) => {
				applySettingsPass();
				return render(width);
			};
			return component;
		});
	};

	const removeWidget = (ctx: ExtensionContext | undefined): void => {
		if (!widgetMounted) return;
		widgetMounted = false;
		if (ctx?.hasUI) {
			try {
				ctx.ui.setWidget(HOST_EDITOR_WIDGET_KEY, undefined);
			} catch {
				// Widget removal is best effort during teardown.
			}
		}
	};

	const seedTranscript = (target: SteerViewTarget, assemblerTarget: ChildConversationAssembler): void => {
		const records: SteerTranscriptRecord[] = [];
		if (target.transcriptPath) {
			const tail = createTranscriptTail(target.transcriptPath, { trustedRoots: trustedRootsForTarget(target) });
			records.push(...tail.poll().records);
		} else {
			records.push(...readTranscriptFallback(target, 80).records);
		}
		assemblerTarget.seedTranscriptRecords(records);
	};

	const refreshCommands = (): Promise<Set<string>> => commandValidator?.refreshCommands() ?? Promise.resolve(new Set());

	const validateAndExecuteCommand = (name: string, args: string, streamingBehavior: InputEvent["streamingBehavior"]): Promise<boolean> =>
		commandValidator?.validateAndExecute(name, args, streamingBehavior) ?? Promise.resolve(false);

	/** Feed raw RPC stdout lines: relay notify UI requests, everything else
	 *  goes through the native assembler. */
	const onRpcLine = (line: string): void => {
		let record: { type?: string; method?: string; message?: string };
		try {
			record = JSON.parse(line) as typeof record;
		} catch {
			return;
		}
		if (record.type === "extension_ui_request" && record.method === "notify") {
			notify?.(typeof record.message === "string" ? record.message : "Child notification", "info");
			return;
		}
		if (record.type === "agent_settled") turnActive = false;
		assembler?.addRpcLine(line);
	};

	const subscribeStdout = (channel: ChildConversationChannel): void => {
		unsubscribeStdout?.();
		unsubscribeStdout = channel.onStdoutLine((line) => onRpcLine(line));
	};

	/** Minimum gap between channel re-resolves; a reopened child that dies
	 *  instantly (corrupt session, spawn failure) must not loop forever. */
	const CHANNEL_SWAP_MIN_INTERVAL_MS = 2000;
	let lastChannelClosedAt = 0;

	/** Channel-death handling: re-resolve the target when the active channel
	 *  closes (runner exit / child die / reopen race). A reopened channel swaps
	 *  in seamlessly and feeds the SAME accumulated assembler conversation; if
	 *  nothing can be resolved the mode closes with the existing notice. */
	const watchClosed = (channel: ChildConversationChannel): void => {
		channel.closed.then(async () => {
			if (disposed || !active || currentChannel !== channel || !lastCtx || !currentTarget) return;
			const closedAt = Date.now();
			if (closedAt - lastChannelClosedAt < CHANNEL_SWAP_MIN_INTERVAL_MS) {
				// The previous channel died moments ago (open→reopen→immediate
				// death); stop re-resolving instead of spawning reopen children
				// in a tight loop.
				notify?.("Child agent process ended; conversation mode closed.", "warning");
				closeConversation(undefined);
				return;
			}
			lastChannelClosedAt = closedAt;
			const next = await resolveChildChannel(lastCtx, currentTarget);
			// The user may have closed or switched targets while resolving.
			if (disposed || !active || currentChannel !== channel || !lastCtx || !currentTarget) return;
			if (next && next !== channel) {
				subscribeStdout(next);
				currentChannel = next;
				watchClosed(next);
				next.touch();
				notify?.("Child conversation resumed via reopened session.", "info");
				lastCtx.ui.requestRender?.();
			} else {
				notify?.("Child agent process ended; conversation mode closed.", "warning");
				closeConversation(undefined);
			}
		});
	};

	const closeConversation = (ctx: ExtensionContext | undefined): void => {
		if (!active) return;
		active = false;
		const uiCtx = ctx ?? lastCtx;
		removeWidget(uiCtx);
		unsubscribeStdout?.();
		unsubscribeStdout = undefined;
		if (uiCtx?.hasUI) {
			try {
				uiCtx.ui.setStatus(HOST_EDITOR_WIDGET_KEY, undefined);
			} catch {
				// Status clearing is best effort during teardown.
			}
		}
		assembler?.dispose();
		assembler = undefined;
		settingsReader = undefined;
		commandValidator?.reset();
		commandValidator = undefined;
		turnActive = false;
		toolsExpandedOverride = undefined;
		hideThinkingOverride = undefined;
		// Stop the channel's viewer-side session (bridge heartbeat so the
		// runner can exit); a LocalRpcChannel no-ops and keeps its resident.
		currentChannel?.endConversation?.();
		currentChannel = undefined;
		currentTarget = undefined;
		lastCtx = undefined;
	};

	return {
		get active() { return active; },
		get targetKey() { return currentTarget?.key; },
		open(ctx, target, channel) {
			if (disposed || active) return false;
			if (!channel) return false;
			active = true;
			currentTarget = target;
			lastCtx = ctx;
			currentChannel = channel;
			toolsExpandedOverride = undefined;
			hideThinkingOverride = undefined;
			settingsReader = createViewerSettingsReader({ cwd: ctx.cwd });
			assembler = createChildConversationAssembler({
				ui: ctx.ui as unknown as TUI,
				cwd: ctx.cwd ?? "",
				settings: settingsReader.read(),
				toolOutputExpanded: currentExpanded(),
			});
			commandValidator = createChildCommandValidator({
				getChannel: () => currentChannel,
				getResidentKey: () => currentChannel?.key,
				notify,
			});
			turnActive = false;
			seedTranscript(target, assembler);
			ensureWidget(ctx);
			subscribeStdout(channel);
			watchClosed(channel);
			if (ctx.hasUI) {
				ctx.ui.setStatus(HOST_EDITOR_WIDGET_KEY, statusLine(target));
			}
			return true;
		},
		close: closeConversation,
		routeInput(input) {
			if (!active || disposed) return { action: "continue" };
			const channel = currentChannel;
			if (!channel) return { action: "continue" };
			// Child process already gone: exit child mode so the parent receives
			// this input instead of silently writing into a dead child.
			if (typeof channel.exitCode === "number") {
				this.close(undefined);
				notify?.("Child agent process ended; returning to parent input.", "warning");
				return { action: "continue" };
			}
			channel.touch();
			const text = input.text;
			// Slash ownership: `!bash` and single `/` stay parent-owned.
			if (text.startsWith("!")) return { action: "continue" };
			if (text.startsWith("//")) {
				const rest = text.slice(2);
				const spaceIndex = rest.indexOf(" ");
				const name = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex);
				const args = spaceIndex === -1 ? "" : rest.slice(spaceIndex + 1);
				assembler?.submitUserText(text);
				turnActive = true;
				// Validate against the child's command list before executing;
				// never fall through to a child LLM prompt.
				void validateAndExecuteCommand(name, args, input.streamingBehavior);
				return { action: "handled" };
			}
			if (text.startsWith("/")) return { action: "continue" };
			channel.write({
				type: "prompt",
				message: text,
				streamingBehavior: input.streamingBehavior,
				...(input.images && input.images.length > 0 ? { images: input.images } : {}),
			});
			assembler?.submitUserText(text);
			turnActive = true;
			return { action: "handled" };
		},
		isStreaming() {
			return turnActive || (assembler?.isStreaming() ?? false);
		},
		getActiveChannel() {
			return active ? currentChannel : undefined;
		},
		getUiContext() {
			return active ? lastCtx : undefined;
		},
		toggleToolExpansion() {
			toolsExpandedOverride = !(toolsExpandedOverride ?? currentExpanded());
			applySettingsPass();
			lastCtx?.ui.requestRender?.();
		},
		toggleThinkingHidden() {
			const base = (settingsReader?.read() ?? createViewerSettingsReader({ cwd: lastCtx?.cwd }).read()).hideThinkingBlock;
			hideThinkingOverride = !(hideThinkingOverride ?? base);
			applySettingsPass();
			lastCtx?.ui.requestRender?.();
		},
		dispose() {
			disposed = true;
			this.close(undefined);
		},
	};
}