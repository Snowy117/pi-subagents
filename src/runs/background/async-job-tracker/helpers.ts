import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatControlNoticeMessage } from "../../shared/subagent-control.ts";
import {
	type AsyncJobState,
	type ControlEvent,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
} from "../../../shared/types.ts";
import { normalizeParallelGroups } from "../parallel-groups.ts";
import type { AsyncRunSummary } from "../async-status.ts";

export interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	pollIntervalMs?: number;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

export const CONTROL_EVENT_READ_CHUNK_BYTES = 64 * 1024;
export const MAX_CONTROL_EVENT_LINE_BYTES = 1024 * 1024;
export const CONTROL_EVENT_SCAN_WINDOW_BYTES = 2 * 1024 * 1024;

export function restoredControlEventCursor(asyncDir: string): number {
	try {
		return fs.statSync(path.join(asyncDir, "events.jsonl")).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

export function summaryToJob(run: AsyncRunSummary): AsyncJobState {
	const groups = normalizeParallelGroups(run.parallelGroups, run.steps.length, run.chainStepCount ?? run.steps.length);
	const activeGroup = run.currentStep !== undefined
		? groups.find((group) => run.currentStep! >= group.start && run.currentStep! < group.start + group.count)
		: undefined;
	const visibleSteps = activeGroup
		? run.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count).map((step, index) => ({ ...step, index: activeGroup.start + index }))
		: run.steps.map((step, index) => ({ ...step, index }));
	return {
		asyncId: run.id,
		asyncDir: run.asyncDir,
		status: run.state,
		sessionId: run.sessionId,
		activityState: run.activityState,
		lastActivityAt: run.lastActivityAt,
		currentTool: run.currentTool,
		currentToolStartedAt: run.currentToolStartedAt,
		currentPath: run.currentPath,
		turnCount: run.turnCount,
		toolCount: run.toolCount,
		mode: run.mode,
		agents: visibleSteps.map((step) => step.agent),
		currentStep: run.currentStep,
		chainStepCount: run.chainStepCount,
		parallelGroups: groups,
		steps: visibleSteps,
		stepsTotal: visibleSteps.length,
		runningSteps: visibleSteps.filter((step) => step.status === "running").length,
		completedSteps: visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length,
		hasParallelGroups: groups.length > 0,
		activeParallelGroup: Boolean(activeGroup),
		startedAt: run.startedAt,
		updatedAt: run.lastUpdate ?? run.startedAt,
		timeoutMs: run.timeoutMs,
		deadlineAt: run.deadlineAt,
		timedOut: run.timedOut,
		turnBudget: run.turnBudget,
		turnBudgetExceeded: run.turnBudgetExceeded,
		wrapUpRequested: run.wrapUpRequested,
		sessionDir: run.sessionDir,
		outputFile: run.outputFile,
		totalTokens: run.totalTokens,
		sessionFile: run.sessionFile,
		controlEventCursor: restoredControlEventCursor(run.asyncDir),
		nestedChildren: run.nestedChildren,
	};
}

export function emitNewControlEvents(pi: Pick<ExtensionAPI, "events">, job: AsyncJobState): void {
	const eventsPath = path.join(job.asyncDir, "events.jsonl");
	let fd: number;
	try {
		fd = fs.openSync(eventsPath, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		console.error(`Failed to open async control events for '${job.asyncDir}':`, error);
		return;
	}
	try {
		const stat = fs.fstatSync(fd);
		const savedCursor = job.controlEventCursor;
		let cursor = stat.size < (savedCursor ?? 0) ? 0 : (savedCursor ?? 0);
		const startedFromTail = savedCursor === undefined && stat.size > CONTROL_EVENT_SCAN_WINDOW_BYTES;
		if (startedFromTail) cursor = stat.size - CONTROL_EVENT_SCAN_WINDOW_BYTES;
		if (stat.size <= cursor) return;
		const scanEnd = Math.min(stat.size, cursor + CONTROL_EVENT_SCAN_WINDOW_BYTES);
		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				console.error(`Ignoring malformed async control event in '${eventsPath}':`, error);
				return;
			}
			if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "subagent.control") return;
			const record = parsed as { event?: ControlEvent; channels?: string[]; childIntercomTarget?: string; noticeText?: string; intercom?: { to?: string; message?: string } };
			if (!record.event || !Array.isArray(record.channels)) return;
			const payload = {
				event: record.event,
				source: "async" as const,
				asyncDir: job.asyncDir,
				childIntercomTarget: record.childIntercomTarget,
				noticeText: record.noticeText ?? formatControlNoticeMessage(record.event, record.childIntercomTarget),
			};
			if (record.channels.includes("event")) {
				pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
			}
			if (record.event.type !== "active_long_running" && record.channels.includes("intercom") && record.intercom?.to && record.intercom.message) {
				pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
					...payload,
					to: record.intercom.to,
					message: record.intercom.message,
				});
			}
		};
		let readCursor = cursor;
		let lastCompleteCursor = cursor;
		let lineParts: Buffer[] = [];
		let lineBytes = 0;
		let skippingOversizedLine = startedFromTail;
		const appendLineSegment = (segment: Buffer) => {
			if (segment.length === 0 || skippingOversizedLine) return;
			if (lineBytes + segment.length > MAX_CONTROL_EVENT_LINE_BYTES) {
				lineParts = [];
				lineBytes = 0;
				skippingOversizedLine = true;
				return;
			}
			lineParts.push(segment);
			lineBytes += segment.length;
		};
		while (readCursor < scanEnd) {
			const toRead = Math.min(CONTROL_EVENT_READ_CHUNK_BYTES, scanEnd - readCursor);
			const buffer = Buffer.alloc(toRead);
			const bytesRead = fs.readSync(fd, buffer, 0, toRead, readCursor);
			if (bytesRead <= 0) break;
			const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
			let lineStart = 0;
			for (let index = 0; index < chunk.length; index++) {
				if (chunk[index] !== 0x0a) continue;
				appendLineSegment(chunk.subarray(lineStart, index));
				if (!skippingOversizedLine && lineBytes > 0) {
					handleLine(Buffer.concat(lineParts, lineBytes).toString("utf-8"));
				}
				lineParts = [];
				lineBytes = 0;
				skippingOversizedLine = false;
				lastCompleteCursor = readCursor + index + 1;
				lineStart = index + 1;
			}
			appendLineSegment(chunk.subarray(lineStart));
			readCursor += bytesRead;
			if (skippingOversizedLine) job.controlEventCursor = readCursor;
		}
		if (lastCompleteCursor > cursor) job.controlEventCursor = lastCompleteCursor;
		else if (scanEnd < stat.size || startedFromTail) job.controlEventCursor = scanEnd;
	} catch (error) {
		console.error(`Failed to read async control events for '${job.asyncDir}':`, error);
	} finally {
		fs.closeSync(fd);
	}
}
