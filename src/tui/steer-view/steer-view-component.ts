import { matchesKey, truncateToWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { retainLiveTranscript } from "../../shared/live-transcript.ts";
import { consumeTargetActionResponse, requestTargetThinkingCycle } from "./control-routing.ts";
import { createTranscriptTail, readTranscriptFallback, trustedRootsForTarget, type SteerTranscriptRecord } from "./transcript-tail.ts";
import type { SteerViewTarget } from "./target-model.ts";
import { createChildConversationAssembler, type ChildConversationAssembler } from "../child-conversation/assembler.ts";
import { createViewerSettingsReader } from "../child-conversation/viewer-settings.ts";
import type { TranscriptSeedRecord } from "../child-conversation/assembly-types.ts";

export type SteerViewResult = { kind: "picker" } | { kind: "slash"; text: string };

export interface SteerViewComponentOptions {
	pollIntervalMs?: number;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
	autoStart?: boolean;
	refreshTarget?: () => SteerViewTarget | undefined;
	/** Project working directory for project-scoped viewer settings. */
	cwd?: string;
	/** Tool-expansion state (public `ctx.ui.getToolsExpanded()` when available;
	 *  defaults to collapsed when absent, matching the app default). */
	getToolsExpanded?: () => boolean;
}

/** Transcript records normally carry the full serialized Message object the
 *  native assembler seeds from. Limited/legacy writers may omit it; synthesize
 *  a minimal Message so the record still renders as a real native component
 *  instead of being dropped. */
function toSeedRecord(record: SteerTranscriptRecord): TranscriptSeedRecord {
	if (record.recordType !== "message" || !record.role || record.message) return record;
	return {
		recordType: "message",
		ts: record.ts,
		role: record.role,
		// Native components expect block-array content (AssistantMessageComponent
		// iterates content as an array); synthesize a text block.
		message: { role: record.role, content: [{ type: "text", text: record.text ?? "" }] },
	};
}

/**
 * Degraded child-conversation surface: full-screen overlay used only when no
 * ChildConversationChannel can be resolved (no resident child, no runner-side
 * bridge, no reopenable session — e.g. `--no-session`). The header states
 * explicitly that conversation continuity is unavailable; the transcript
 * renders through the SAME native child-conversation assembler the host-editor
 * widget uses (User/Assistant/ToolExecution/Custom/Bash components, settings
 * aware), so the degraded path never falls back to self-drawn message lines.
 * There is no input surface — this is a read-only view. Esc/ctrl+c returns
 * to the picker; shift+tab cycles thinking; PgUp/PgDn/Up/Down scroll.
 */
export class SteerViewComponent implements Component, Focusable {
	private readonly assembler: ChildConversationAssembler;
	private readonly settingsReader: ReturnType<typeof createViewerSettingsReader>;
	private tail;
	private releaseTranscript: () => void;
	private tailPath?: string;
	private readonly timer?: ReturnType<typeof setInterval>;
	private records: SteerTranscriptRecord[] = [];
	private scrollOffset = 0;
	private unseen = 0;
	private notice = "";
	private thinkingLevel = "";
	private pendingActions = new Set<string>();
	private disposed = false;
	private _focused = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly target: SteerViewTarget;
	private readonly done: (result: SteerViewResult) => void;
	private readonly options: SteerViewComponentOptions;

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; }

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
		this.settingsReader = createViewerSettingsReader({ cwd: options.cwd });
		this.assembler = createChildConversationAssembler({
			ui: tui,
			cwd: options.cwd ?? "",
			settings: this.settingsReader.read(),
			toolOutputExpanded: this.readExpanded(),
		});
		this.poll();
		if (options.autoStart !== false) {
			this.timer = (options.setInterval ?? setInterval)(() => this.poll(), options.pollIntervalMs ?? 250);
			this.timer.unref?.();
		}
	}

	private readExpanded(): boolean {
		try {
			return this.options.getToolsExpanded?.() ?? false;
		} catch {
			// A stale UI context must not break the settings pass.
			return false;
		}
	}

	/** Re-apply settings (TTL-cached disk reads) so /settings toggles and tool
	 *  expansion state land on the next render pass, like the host-editor
	 *  widget's per-render settings pass. */
	private applySettingsPass(): void {
		this.assembler.applySettings(this.settingsReader.read(), this.readExpanded());
	}

	/** Feed newly-polled records into the native assembler. A transcript
	 *  replace/rotate (reset) rebuilds the assembled tree from the re-read
	 *  beginning so stale components never linger. */
	private feedRecords(records: readonly SteerTranscriptRecord[], reset: boolean): void {
		if (!this.assembler) return;
		if (reset) this.assembler.dispose();
		if (records.length > 0) this.assembler.seedTranscriptRecords(records.map(toSeedRecord));
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
			this.feedRecords(update.records, update.reset);
			if (this.records.length > 1000) this.records.splice(0, this.records.length - 1000);
			if (wasFollowing) this.scrollOffset = 0;
			else this.unseen += update.records.length;
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
		if (matchesKey(data, "pageup") || matchesKey(data, "up")) {
			this.scrollOffset += matchesKey(data, "pageup") ? 10 : 1;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pagedown") || matchesKey(data, "down")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - (matchesKey(data, "pagedown") ? 10 : 1));
			if (this.scrollOffset === 0) this.unseen = 0;
			this.tui.requestRender();
			return;
		}
	}

	render(width: number): string[] {
		this.applySettingsPass();
		const safeWidth = Math.max(1, width);
		const header = `subagent: ${this.target.agent} · ${this.target.runId}:${this.target.index} · ${this.target.status} · continuity unavailable${this.thinkingLevel ? ` · thinking ${this.thinkingLevel}` : ""}`;
		const footerRows = 2;
		const available = Math.max(1, this.tui.terminal.rows - footerRows);
		const rendered = this.assembler.container.render(safeWidth);
		this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, rendered.length - available));
		const end = Math.max(0, rendered.length - this.scrollOffset);
		const body = rendered.slice(Math.max(0, end - available), end);
		while (body.length < available) body.unshift("");
		const notice = `${this.notice}${this.unseen > 0 ? ` · ↓ ${this.unseen} new` : ""}`;
		return [
			truncateToWidth(this.theme.fg("accent", this.theme.bold(header)), safeWidth),
			...body.map((line) => truncateToWidth(line, safeWidth)),
			truncateToWidth(this.theme.fg("muted", notice || "read-only · shift+tab thinking · PgUp/PgDn scroll · Esc back"), safeWidth),
		];
	}

	invalidate(): void {
		this.assembler.container.invalidate();
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.timer) (this.options.clearInterval ?? clearInterval)(this.timer);
		this.releaseTranscript();
		this.assembler.dispose();
	}
}