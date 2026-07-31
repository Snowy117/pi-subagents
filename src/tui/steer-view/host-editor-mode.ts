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
 * The widget strip shows the selected child's conversation: its initial
 * history is seeded from the child transcript file, and follow-up prompt
 * responses stream in live from the child's RPC stdout (`message_end`,
 * `tool_execution_*`, `agent_settled` records). RPC `extension_ui_request`
 * records are relayed as viewer notices; unknown `//name` commands produce a
 * visible "command unavailable" result instead of a silent LLM prompt.
 *
 * Lifecycle safety: when the child process exits (crash, eviction, failed
 * run, timeout) the mode auto-closes so editor input returns to the parent —
 * routed input can never silently dead-end into a dead child. The footer
 * status line shows the active child while the mode is open.
 */

import type { ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";
import type { PersistentRpcChild } from "../../runs/persistent/rpc-child-registry.ts";
import { extractTextFromContent } from "../../shared/utils.ts";
import { createTranscriptTail, readTranscriptFallback, trustedRootsForTarget, type SteerTranscriptRecord } from "./transcript-tail.ts";
import type { SteerViewTarget } from "./target-model.ts";

export const HOST_EDITOR_WIDGET_KEY = "subagents-child-conversation";

/** Maximum transcript lines rendered in the widget strip above the editor. */
const MAX_WIDGET_LINES = 14;
/** History buffer cap: keep enough context beyond the visible strip. */
const MAX_BUFFER_LINES = 60;

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

function recordText(record: SteerTranscriptRecord): string {
	if (record.recordType === "message") {
		const text = record.text ?? "";
		return record.role === "user" ? `You: ${text}` : text;
	}
	if (record.recordType === "tool_start") return `▶ ${record.toolName ?? "tool"}${record.argsPreview ? ` ${record.argsPreview}` : ""}`;
	if (record.recordType === "tool_end") return `✓ ${record.toolName ?? "tool"}`;
	return record.text ?? "";
}

function statusLine(target: SteerViewTarget): string {
	return `subagent: ${target.agent} · ${target.runId}:${target.index} · ${target.status}`;
}

const COMMAND_CACHE_TTL_MS = 30_000;

export function createHostEditorConversation(options: HostEditorModeOptions): HostEditorConversationHandle {
	const { getResidentChild, notify } = options;
	let active = false;
	let disposed = false;
	let currentTarget: SteerViewTarget | undefined;
	let currentResident: PersistentRpcChild | undefined;
	let lastCtx: ExtensionContext | undefined;
	let widgetMounted = false;
	let widgetInvalidate: (() => void) | undefined;
	let widgetLines: string[] = [];
	let rpcBuf = "";
	let commandCache: Set<string> | undefined;
	let commandCacheAt = 0;
	let commandCachePending: Promise<Set<string>> | undefined;
	let stdoutReader: ((chunk: Buffer) => void) | undefined;

	const appendWidgetLine = (line: string): void => {
		const trimmed = line.trim();
		if (!trimmed) return;
		widgetLines.push(trimmed);
		if (widgetLines.length > MAX_BUFFER_LINES) widgetLines.splice(0, widgetLines.length - MAX_BUFFER_LINES);
		widgetInvalidate?.();
		lastCtx?.ui.requestRender?.();
	};

	/** Seed the widget strip from the child's transcript history (pre-open turns). */
	const seedTranscript = (target: SteerViewTarget): void => {
		const lines: string[] = [];
		if (target.transcriptPath) {
			const tail = createTranscriptTail(target.transcriptPath, { trustedRoots: trustedRootsForTarget(target) });
			for (const record of tail.poll().records) {
				const text = recordText(record);
				if (text) lines.push(text);
			}
		} else {
			for (const record of readTranscriptFallback(target, MAX_BUFFER_LINES).records) {
				const text = recordText(record);
				if (text) lines.push(text);
			}
		}
		widgetLines = lines.length > MAX_BUFFER_LINES ? lines.slice(lines.length - MAX_BUFFER_LINES) : lines;
	};

	const ensureWidget = (ctx: ExtensionContext): void => {
		if (widgetMounted || !ctx.hasUI) return;
		widgetMounted = true;
		ctx.ui.setWidget(HOST_EDITOR_WIDGET_KEY, (_tui, theme: Theme) => {
			const widget = {
				render(width: number) {
					const target = currentTarget;
					const header = statusLine(target ?? {
						key: "foreground:?:?", kind: "foreground" as const, runId: "?", index: 0,
						agent: "child", status: "", active: false, updatedAt: Date.now(),
					});
					return [
						theme.fg("accent", theme.bold(header)),
						...widgetLines.slice(-MAX_WIDGET_LINES).map((line) =>
							line.length > width ? `${line.slice(0, Math.max(0, width - 3))}…` : line),
					];
				},
				invalidate() {
					// Nothing cached beyond widgetLines; keep the contract for pi.
				},
			};
			widgetInvalidate = () => widget.invalidate();
			return widget;
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
		return true;
	};

	/** Feed follow-up RPC records into the widget strip (message/tool/settled). */
	const onRpcLine = (line: string): void => {
		let record: {
			type?: string;
			method?: string;
			message?: string;
			role?: string;
			content?: unknown;
			toolName?: string;
		};
		try {
			record = JSON.parse(line) as typeof record;
		} catch {
			return;
		}
		// Relay serializable extension UI requests to the parent viewer. notify
		// is the common case (e.g. DCP reporting through ui.notify).
		if (record.type === "extension_ui_request" && record.method === "notify") {
			notify?.(typeof record.message === "string" ? record.message : "Child notification", "info");
			return;
		}
		if (record.type === "message_end" || record.type === "tool_result_end") {
			const message = record as { message?: { role?: string; content?: unknown; text?: string } };
			if (message.message) {
				const text = (extractTextFromContent(message.message.content) || message.message.text || "").trim();
				if (!text) return;
				if (message.message.role === "user") {
					// The child echoes the user's prompt back as its own user message;
					// the submit echo already shows it, so a matching last line is skipped.
					const last = widgetLines[widgetLines.length - 1];
					if (last === `You: ${text}` || (last?.startsWith("You: ") && text.startsWith(last.slice(5)))) return;
					appendWidgetLine(`You: ${text}`);
				} else {
					appendWidgetLine(text);
				}
			}
			return;
		}
		if (record.type === "tool_execution_start" && record.toolName) {
			appendWidgetLine(`▶ ${record.toolName}`);
			return;
		}
		if (record.type === "tool_execution_end" && record.toolName) {
			appendWidgetLine(`✓ ${record.toolName}`);
			return;
		}
		if (record.type === "agent_settled") {
			appendWidgetLine("— agent settled —");
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
			lastCtx = ctx;
			commandCache = undefined;
			commandCacheAt = 0;
			commandCachePending = undefined;
			rpcBuf = "";
			seedTranscript(target);
			ensureWidget(ctx);
			// Stream the child's RPC records so follow-up responses and extension
			// UI requests reach the viewer. Chunks are line-buffered so records
			// split across chunk boundaries are not lost.
			const stdout = resident.proc.stdout;
			if (stdout && !stdoutReader) {
				stdoutReader = (chunk: Buffer) => {
					rpcBuf += chunk.toString();
					const lines = rpcBuf.split("\n");
					rpcBuf = lines.pop() || "";
					for (const line of lines) {
						if (line.trim()) onRpcLine(line);
					}
				};
				stdout.on("data", stdoutReader);
			}
			// Auto-exit when the child process dies so parent input routing
			// resumes; a stale watcher (previous resident) is a no-op.
			const watched = resident;
			void resident.closed.then(() => {
				if (disposed) return;
				if (active && currentResident === watched) {
					notify?.("Child agent process ended; conversation mode closed.", "warning");
					this.close(undefined);
				}
			});
			if (ctx.hasUI) {
				ctx.ui.setStatus(HOST_EDITOR_WIDGET_KEY, statusLine(target));
			}
			return true;
		},
		close(ctx) {
			if (!active) return;
			active = false;
			const uiCtx = ctx ?? lastCtx;
			removeWidget(uiCtx);
			if (currentResident && stdoutReader) {
				const stdout = currentResident.proc.stdout;
				stdout?.removeListener("data", stdoutReader);
				stdoutReader = undefined;
			}
			if (uiCtx?.hasUI) {
				try {
					uiCtx.ui.setStatus(HOST_EDITOR_WIDGET_KEY, undefined);
				} catch {
					// Status clearing is best effort during teardown.
				}
			}
			currentTarget = undefined;
			currentResident = undefined;
			lastCtx = undefined;
			commandCache = undefined;
			commandCachePending = undefined;
			widgetLines = [];
			rpcBuf = "";
		},
		routeInput(input) {
			if (!active || disposed) return { action: "continue" };
			const resident = currentResident;
			if (!resident) return { action: "continue" };
			// Child process already gone: exit child mode so the parent receives
			// this input instead of silently writing into a dead child.
			if (resident.proc.exitCode !== null) {
				this.close(undefined);
				notify?.("Child agent process ended; returning to parent input.", "warning");
				return { action: "continue" };
			}
			const text = input.text;
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
				appendWidgetLine(text);
				// Validate against the child's command list before executing;
				// never fall through to a child LLM prompt (R6).
				void validateAndExecuteCommand(resident, name, args, input.streamingBehavior);
				return { action: "handled" };
			}
			if (text.startsWith("/")) return { action: "continue" };
			resident.write.write({ type: "prompt", message: text, streamingBehavior: input.streamingBehavior });
			appendWidgetLine(`You: ${text}`);
			return { action: "handled" };
		},
		dispose() {
			disposed = true;
			this.close(undefined);
			currentResident = undefined;
		},
	};
}
