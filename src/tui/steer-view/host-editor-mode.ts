/**
 * Host-editor routing mode for direct child conversation (Phase 4, Option B).
 *
 * When active, the real Pi editor stays mounted and focused; a read-only
 * transcript widget is mounted above it via `ctx.ui.setWidget()`, and ordinary
 * editor submissions are routed to the selected child's resident RPC process
 * through the `pi.on("input")` handler, which returns `{ action: "handled" }`
 * so the parent agent never sees the message.
 *
 * Slash ownership:
 * - single `/` (built-in/extension/skill/template) → parent (Pi dispatches
 *   before the input event; handler returns `continue`);
 * - `!bash` → parent (handled by InteractiveMode before prompt routing);
 * - `//name args` → selected child RPC command, validated against the child's
 *   `get_commands` list (never falls through to a child LLM prompt);
 * - ordinary text → selected child RPC prompt (steer while streaming).
 *
 * RPC responses and `extension_ui_request` records are read from the child's
 * stdout: `notify` becomes a viewer notice; unknown `//name` commands produce
 * a visible "command unavailable" result instead of a silent LLM prompt.
 */

import type { ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { TUI, Theme } from "@earendil-works/pi-tui";
import type { PersistentRpcChild } from "../../runs/persistent/rpc-child-registry.ts";
import { readTranscriptFallback } from "./transcript-tail.ts";
import type { SteerViewTarget } from "./target-model.ts";

export const HOST_EDITOR_WIDGET_KEY = "subagents-child-conversation";

export interface HostEditorConversationHandle {
	readonly active: boolean;
	readonly targetKey: string | undefined;
	open(ctx: ExtensionContext, target: SteerViewTarget, resident: PersistentRpcChild | undefined): boolean;
	close(ctx: ExtensionContext | undefined): void;
	routeInput(input: InputEvent): InputEventResult;
	dispose(): void;
}

interface HostEditorModeOptions {
	getResidentChild: (target: SteerViewTarget) => PersistentRpcChild | undefined;
	notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

/** Render a bounded read-only tail of the child transcript as a widget. */
function createTranscriptWidget(target: SteerViewTarget, theme: Theme) {
	let lastLineCount = 0;
	return {
		render(width: number) {
			const poll = readTranscriptFallback(target, 40);
			const lines = poll.lines ?? [];
			if (lines.length === lastLineCount) return [];
			lastLineCount = lines.length;
			const bounded = lines.slice(-12).map((line) => ({
				text: line.length > width ? `${line.slice(0, Math.max(0, width - 3))}…` : line,
			}));
			return bounded;
		},
		invalidate() {
			lastLineCount = 0;
		},
	};
}

const COMMAND_CACHE_TTL_MS = 30_000;

export function createHostEditorConversation(options: HostEditorModeOptions): HostEditorConversationHandle {
	const { getResidentChild, notify } = options;
	let active = false;
	let disposed = false;
	let currentTarget: SteerViewTarget | undefined;
	let currentResident: PersistentRpcChild | undefined;
	let widgetMounted = false;
	let widgetInvalidate: (() => void) | undefined;
	let commandCache: Set<string> | undefined;
	let commandCacheAt = 0;
	let commandCachePending: Promise<Set<string>> | undefined;
	let stdoutReader: (chunk: Buffer) => void | undefined;

	const ensureWidget = (ctx: ExtensionContext): void => {
		if (widgetMounted || !ctx.hasUI || !currentTarget) return;
		widgetMounted = true;
		const target = currentTarget;
		ctx.ui.setWidget(HOST_EDITOR_WIDGET_KEY, (tui: TUI, theme: Theme) => {
			const widget = createTranscriptWidget(target, theme);
			widgetInvalidate = () => widget.invalidate();
			void tui;
			return widget as never;
		});
	};

	const removeWidget = (ctx: ExtensionContext | undefined): void => {
		if (!widgetMounted) return;
		widgetMounted = false;
		widgetInvalidate = undefined;
		if (ctx?.hasUI) {
			try {
				ctx.ui.setWidget(HOST_EDITOR_WIDGET_KEY, undefined);
			} catch {
				// Widget removal is best effort during teardown.
			}
		}
	};

	const refreshCommands = (resident: PersistentRpcChild): Promise<Set<string>> => {
		if (commandCache && Date.now() - commandCacheAt < COMMAND_CACHE_TTL_MS) {
			return Promise.resolve(commandCache);
		}
		if (commandCachePending) return commandCachePending;
		const stdout = resident.proc.stdout;
		const requestingKey = resident.key;
		commandCachePending = new Promise((resolve) => {
			let settled = false;
			let listener: ((chunk: Buffer) => void) | undefined;
			const finish = (names: Set<string>, cache: boolean): void => {
				if (settled) return;
				settled = true;
				if (listener && stdout) stdout.removeListener("data", listener);
				commandCachePending = undefined;
				// A stale refresh resolving after a target switch must not write
				// one child's command set into the cache of the active child.
				if (cache && currentResident?.key === requestingKey) {
					commandCache = names;
					commandCacheAt = Date.now();
				}
				resolve(names);
			};
			if (!stdout) {
				// No stdout stream: nothing can be validated; report empty and do
				// not cache so a later open can retry.
				finish(new Set(), false);
				return;
			}
			const timeout = setTimeout(() => finish(new Set(), false), 2000);
			timeout.unref?.();
			const requestId = resident.write.write({ type: "get_commands" });
			listener = (chunk: Buffer): void => {
				for (const line of chunk.toString().split("\n")) {
					if (!line.trim()) continue;
					let record: { id?: string; type?: string; data?: { commands?: Array<{ name?: string }> } };
					try {
						record = JSON.parse(line) as typeof record;
					} catch {
						continue;
					}
					if (record.id !== requestId || record.type !== "response") continue;
					const names = new Set<string>();
					for (const command of record.data?.commands ?? []) {
						if (command?.name) names.add(command.name);
					}
					clearTimeout(timeout);
					finish(names, true);
					return;
				}
			};
			stdout.on("data", listener);
		});
		return commandCachePending;
	};

	const validateAndExecuteCommand = async (resident: PersistentRpcChild, name: string, args: string, streamingBehavior: InputEvent["streamingBehavior"]): Promise<boolean> => {
		const commands = await refreshCommands(resident);
		if (!commands.has(name)) {
			notify?.(`Child command /${name} is unavailable in the selected agent's runtime.`, "warning");
			return false;
		}
		resident.write.write({
			type: "prompt",
			message: `/${name}${args ? ` ${args}` : ""}`,
			streamingBehavior,
		});
		widgetInvalidate?.();
		return true;
	};

	const onRpcLine = (line: string): void => {
		let record: { type?: string; method?: string; message?: string };
		try {
			record = JSON.parse(line) as typeof record;
		} catch {
			return;
		}
		// Relay serializable extension UI requests to the parent viewer. notify
		// is the common case (e.g. DCP reporting through ui.notify).
		if (record.type === "extension_ui_request" && record.method === "notify") {
			notify?.(typeof record.message === "string" ? record.message : "Child notification", "info");
		}
	};

	return {
		get active() { return active; },
		get targetKey() { return currentTarget?.key; },
		open(ctx, target, resident) {
			if (disposed || active) return false;
			if (!resident) return false;
			active = true;
			currentTarget = target;
			currentResident = resident;
			commandCache = undefined;
			commandCacheAt = 0;
			commandCachePending = undefined;
			ensureWidget(ctx);
			// Stream the child's RPC records so responses and extension UI
			// requests reach the viewer.
			const stdout = resident.proc.stdout;
			if (stdout && !stdoutReader) {
				stdoutReader = (chunk: Buffer) => {
					const text = chunk.toString();
					for (const line of text.split("\n")) {
						if (line.trim()) onRpcLine(line);
					}
				};
				stdout.on("data", stdoutReader);
			}
			return true;
		},
		close(ctx) {
			if (!active) return;
			active = false;
			removeWidget(ctx);
			if (currentResident && stdoutReader) {
				const stdout = currentResident.proc.stdout;
				stdout?.removeListener("data", stdoutReader);
				stdoutReader = undefined;
			}
			currentTarget = undefined;
			currentResident = undefined;
			commandCache = undefined;
			commandCachePending = undefined;
		},
		routeInput(input) {
			if (!active || disposed) return { action: "continue" };
			const text = input.text;
			const resident = currentResident;
			if (!resident) return { action: "continue" };
			// Viewer activity keeps the child alive: refresh its idle timestamp so
			// idle/cap eviction never evicts the child being conversed with.
			resident.lastActivityAt = Date.now();
			// Slash ownership: `!bash` and single `/` stay parent-owned.
			if (text.startsWith("!")) return { action: "continue" };
			if (text.startsWith("//")) {
				const rest = text.slice(2);
				const spaceIndex = rest.indexOf(" ");
				const name = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex);
				const args = spaceIndex === -1 ? "" : rest.slice(spaceIndex + 1);
				// Validate against the child's command list before executing;
				// never fall through to a child LLM prompt (R6).
				void validateAndExecuteCommand(resident, name, args, input.streamingBehavior);
				return { action: "handled" };
			}
			if (text.startsWith("/")) return { action: "continue" };
			resident.write.write({ type: "prompt", message: text, streamingBehavior: input.streamingBehavior });
			widgetInvalidate?.();
			return { action: "handled" };
		},
		dispose() {
			disposed = true;
			this.close(undefined);
			currentResident = undefined;
		},
	};
}
