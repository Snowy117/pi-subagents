import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, Text, matchesKey, truncateToWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { retainLiveTranscript } from "../../shared/live-transcript.ts";
import { consumeTargetActionResponse, requestTargetThinkingCycle, sendTargetSteer, type QueuedSteer } from "./control-routing.ts";
import { createTranscriptTail, readTranscriptFallback, trustedRootsForTarget, type SteerTranscriptRecord } from "./transcript-tail.ts";
import type { SteerViewTarget } from "./target-model.ts";

export type SteerViewResult = { kind: "picker" } | { kind: "slash"; text: string };

export interface SteerViewComponentOptions {
	pollIntervalMs?: number;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
	autoStart?: boolean;
	refreshTarget?: () => SteerViewTarget | undefined;
}

function recordText(record: SteerTranscriptRecord): string {
	if (record.recordType === "message") return record.text ?? "";
	if (record.recordType === "tool_start") return `▶ ${record.toolName ?? "tool"}${record.argsPreview ? ` ${record.argsPreview}` : ""}`;
	if (record.recordType === "tool_end") return `✓ ${record.toolName ?? "tool"}`;
	return record.text ?? "";
}

function messageLines(record: SteerTranscriptRecord, width: number, theme: Theme): string[] {
	const text = recordText(record);
	if (!text) return [];
	if (record.recordType === "message" && record.role === "assistant") return new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
	const role = record.recordType === "message" ? `${record.role ?? "message"}: ` : "";
	const color = record.recordType === "truncated" ? "warning" : record.role === "user" ? "accent" : "muted";
	const lines = new Text(theme.fg(color, `${role}${text}`), 0, 0).render(width);
	return record.role === "user" ? lines.map((line) => theme.bg("userMessageBg", line)) : lines;
}

export class SteerViewComponent implements Component, Focusable {
	private readonly input = new Input();
	private tail;
	private releaseTranscript: () => void;
	private tailPath?: string;
	private readonly timer?: ReturnType<typeof setInterval>;
	private records: SteerTranscriptRecord[] = [];
	private scrollOffset = 0;
	private unseen = 0;
	private notice = "";
	private thinkingLevel = "";
	private queuedSteer?: QueuedSteer;
	private pendingActions = new Set<string>();
	private disposed = false;
	private _focused = false;
	private inputFocused = true;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly target: SteerViewTarget;
	private readonly done: (result: SteerViewResult) => void;
	private readonly options: SteerViewComponentOptions;

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value && this.inputFocused; }

	constructor(
		tui: TUI,
		theme: Theme,
		target: SteerViewTarget,
		done: (result: SteerViewResult) => void,
		options: SteerViewComponentOptions = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.target = target;
		this.done = done;
		this.options = options;
		this.tail = target.transcriptPath
			? createTranscriptTail(target.transcriptPath, { trustedRoots: trustedRootsForTarget(target) })
			: undefined;
		this.tailPath = target.transcriptPath;
		this.releaseTranscript = retainLiveTranscript(target.transcriptPath);
		this.input.onSubmit = (value) => this.submit(value);
		this.input.onEscape = () => this.done({ kind: "picker" });
		this.poll();
		if (options.autoStart !== false) {
			this.timer = (options.setInterval ?? setInterval)(() => this.poll(), options.pollIntervalMs ?? 250);
			this.timer.unref?.();
		}
	}

	poll(): void {
		if (this.disposed) return;
		const refreshed = this.options.refreshTarget?.();
		if (refreshed) Object.assign(this.target, refreshed);
		if (this.target.transcriptPath && this.target.transcriptPath !== this.tailPath) {
			this.releaseTranscript();
			this.tailPath = this.target.transcriptPath;
			this.tail = createTranscriptTail(this.tailPath, { trustedRoots: trustedRootsForTarget(this.target) });
			this.releaseTranscript = retainLiveTranscript(this.tailPath);
		}
		let update = this.tail?.poll() ?? readTranscriptFallback(this.target);
		if (update.records.length === 0 && this.records.length === 0) {
			const fallback = readTranscriptFallback(this.target);
			if (fallback.records.length > 0) update = fallback;
		}
		const wasFollowing = this.scrollOffset === 0;
		if (update.reset) this.records = [];
		if (update.records.length > 0) {
			this.records.push(...update.records);
			if (this.records.length > 1000) this.records.splice(0, this.records.length - 1000);
			if (wasFollowing) this.scrollOffset = 0;
			else this.unseen += update.records.length;
			if (this.queuedSteer && update.records.some((record) =>
				record.recordType === "message" && record.role === "user"
					&& record.ts >= this.queuedSteer!.ts
					&& record.text?.includes(this.queuedSteer!.deliveryMarker))) {
				this.notice = "✓ steer delivered";
				this.queuedSteer = undefined;
			}
		}
		for (const requestId of [...this.pendingActions]) {
			const response = consumeTargetActionResponse(this.target, requestId);
			if (!response) continue;
			this.pendingActions.delete(response.requestId);
			if (response.status === "applied") {
				const result = response.result as { thinkingLevel?: unknown } | undefined;
				this.thinkingLevel = typeof result?.thinkingLevel === "string" ? result.thinkingLevel : this.thinkingLevel;
				this.notice = `✓ thinking ${this.thinkingLevel || "updated"}`;
			} else this.notice = `Thinking rejected: ${response.error}`;
		}
		if (update.warnings.length > 0 && this.records.length === 0) this.notice = update.warnings.at(-1)!;
		this.tui.requestRender();
	}

	private currentTarget(): SteerViewTarget {
		if (!this.options.refreshTarget) return this.target;
		const refreshed = this.options.refreshTarget();
		if (!refreshed) throw new Error("This child is no longer available.");
		Object.assign(this.target, refreshed);
		return this.target;
	}

	private submit(value: string): void {
		const text = value.trim();
		if (!text) return;
		if (text.startsWith("/")) {
			this.done({ kind: "slash", text });
			return;
		}
		try {
			this.queuedSteer = sendTargetSteer(this.currentTarget(), text);
			this.notice = "Steer queued; applies at the next safe turn";
			this.input.setValue("");
		} catch (error) {
			this.notice = error instanceof Error ? error.message : String(error);
		}
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ kind: "picker" });
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			try {
				const request = requestTargetThinkingCycle(this.currentTarget());
				this.pendingActions.add(request.id);
				this.notice = "Thinking change queued";
			} catch (error) {
				this.notice = error instanceof Error ? error.message : String(error);
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.inputFocused = !this.inputFocused;
			this.input.focused = this._focused && this.inputFocused;
			this.tui.requestRender();
			return;
		}
		const empty = this.input.getValue().length === 0;
		if ((!this.inputFocused || empty) && (matchesKey(data, "pageup") || matchesKey(data, "up"))) {
			this.scrollOffset += matchesKey(data, "pageup") ? 10 : 1;
			this.tui.requestRender();
			return;
		}
		if ((!this.inputFocused || empty) && (matchesKey(data, "pagedown") || matchesKey(data, "down"))) {
			this.scrollOffset = Math.max(0, this.scrollOffset - (matchesKey(data, "pagedown") ? 10 : 1));
			if (this.scrollOffset === 0) this.unseen = 0;
			this.tui.requestRender();
			return;
		}
		if (this.inputFocused) this.input.handleInput(data);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const header = `${this.target.agent} · ${this.target.runId}:${this.target.index} · ${this.target.status}${this.thinkingLevel ? ` · thinking ${this.thinkingLevel}` : ""}`;
		const footerRows = 3;
		const available = Math.max(1, this.tui.terminal.rows - footerRows);
		const rendered = this.records.flatMap((record) => [...messageLines(record, safeWidth, this.theme), ""]);
		this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, rendered.length - available));
		const end = Math.max(0, rendered.length - this.scrollOffset);
		const body = rendered.slice(Math.max(0, end - available), end);
		while (body.length < available) body.unshift("");
		const notice = `${this.notice}${this.unseen > 0 ? ` · ↓ ${this.unseen} new` : ""}`;
		return [
			truncateToWidth(this.theme.fg("accent", this.theme.bold(header)), safeWidth),
			...body.map((line) => truncateToWidth(line, safeWidth)),
			truncateToWidth(this.theme.fg("muted", notice || "Enter steer · shift+tab thinking · PgUp/PgDn scroll · Esc back"), safeWidth),
			...this.input.render(safeWidth).map((line) => truncateToWidth(line, safeWidth)),
		];
	}

	invalidate(): void { this.input.invalidate(); }
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.timer) (this.options.clearInterval ?? clearInterval)(this.timer);
		this.releaseTranscript();
	}
}
