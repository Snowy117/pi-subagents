import * as fs from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toModelInfo, getSupportedThinkingLevels } from "../../../shared/model-info.ts";
import {
	claimControlActionRequests,
	cleanupControlActionFiles,
	writeControlActionResponse,
	type ControlActionChannelDeps,
	type ControlActionChannelFs,
} from "../control-actions/channel.ts";
import { CONTROL_ACTION_VERSION, type ChildControlActionRequest, type ChildControlActionResponse } from "../control-actions/actions.ts";
import { SUBAGENT_ACTION_CONTROL_DIR_ENV } from "../pi-args.ts";

type ActionPi = Pick<ExtensionAPI, "getThinkingLevel" | "setThinkingLevel">;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function applyControlAction(
	pi: ActionPi,
	request: ChildControlActionRequest,
	model: Model<Api> | undefined,
	now: () => number = Date.now,
): ChildControlActionResponse {
	const reject = (error: string): ChildControlActionResponse => ({
		version: CONTROL_ACTION_VERSION,
		type: "action_response",
		requestId: request.id,
		ts: now(),
		status: "rejected",
		action: request.action,
		error,
	});
	if (request.action !== "cycleThinking") return reject(`Unknown control action: ${request.action}.`);
	if (request.payload !== undefined) return reject("cycleThinking does not accept a payload.");
	if (!model) return reject("No current model metadata is available.");
	const modelInfo = toModelInfo(model);
	if (modelInfo.reasoning !== true) return reject("The current model does not support reasoning.");
	const supported = getSupportedThinkingLevels(modelInfo);
	if (supported.length === 0) return reject("The current model has no supported thinking levels.");
	try {
		const current = pi.getThinkingLevel();
		const currentIndex = supported.indexOf(current);
		const next = supported[(currentIndex + 1 + supported.length) % supported.length]!;
		pi.setThinkingLevel(next);
		const thinkingLevel = pi.getThinkingLevel();
		return {
			version: CONTROL_ACTION_VERSION,
			type: "action_response",
			requestId: request.id,
			ts: now(),
			status: "applied",
			action: request.action,
			result: { thinkingLevel },
		};
	} catch (error) {
		return reject(`Failed to cycle thinking level: ${errorMessage(error)}`);
	}
}

export interface ControlActionInboxDeps {
	env?: NodeJS.ProcessEnv;
	fs?: ControlActionChannelFs & Pick<typeof fs, "watch">;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
	now?: () => number;
	random?: () => number;
	pid?: number;
	wait?: (delayMs: number) => void;
}

export function registerControlActionInbox(pi: ExtensionAPI, deps: ControlActionInboxDeps = {}): void {
	const targetDir = (deps.env ?? process.env)[SUBAGENT_ACTION_CONTROL_DIR_ENV]?.trim();
	if (!targetDir) return;
	const fsImpl = deps.fs ?? fs;
	const setIntervalImpl = deps.setInterval ?? setInterval;
	const clearIntervalImpl = deps.clearInterval ?? clearInterval;
	const now = deps.now ?? Date.now;
	const channelDeps: ControlActionChannelDeps = {
		fs: fsImpl,
		now,
		random: deps.random,
		pid: deps.pid,
		wait: deps.wait,
	};
	let currentModel: Model<Api> | undefined;
	let disposed = false;
	let flushing = false;
	let started = false;
	let watcher: fs.FSWatcher | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	const authoritativeResponses = new Map<string, ChildControlActionResponse>();
	const pendingResponseIds = new Set<string>();

	const flush = (): void => {
		if (disposed || flushing) return;
		flushing = true;
		try {
			for (const requestId of pendingResponseIds) {
				const response = authoritativeResponses.get(requestId);
				if (!response) {
					pendingResponseIds.delete(requestId);
					continue;
				}
				try {
					writeControlActionResponse(targetDir, response, channelDeps);
					pendingResponseIds.delete(requestId);
				} catch {
					// Keep the authoritative response in memory for the next filesystem poll.
				}
			}
			for (const request of claimControlActionRequests(targetDir, channelDeps)) {
				const response = authoritativeResponses.get(request.id) ?? applyControlAction(pi, request, currentModel, now);
				authoritativeResponses.set(request.id, response);
				pendingResponseIds.add(request.id);
				try {
					writeControlActionResponse(targetDir, response, channelDeps);
					pendingResponseIds.delete(request.id);
				} catch {
					// The claimed action must not be applied twice; retain only its response for retry.
				}
			}
			cleanupControlActionFiles(targetDir, {}, channelDeps);
		} catch {
			// A damaged or temporarily unavailable inbox must not terminate the child runtime.
		} finally {
			flushing = false;
		}
	};
	const start = (): void => {
		if (started || disposed) return;
		try {
			fsImpl.mkdirSync(targetDir, { recursive: true });
			watcher = fsImpl.watch(targetDir, { recursive: true }, flush);
			watcher.on("error", () => {
				// Polling remains authoritative if the filesystem watcher fails.
			});
		} catch {
			// Recursive watching is unavailable on some platforms; polling remains active.
			watcher = undefined;
		}
		started = true;
		interval = setIntervalImpl(flush, 250);
		interval.unref?.();
		flush();
	};
	const captureModel = (_event: unknown, ctx: ExtensionContext): void => {
		currentModel = ctx.model;
		start();
		flush();
	};
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => void;
	onRuntimeEvent("session_start", captureModel);
	onRuntimeEvent("model_select", (event: unknown, ctx: ExtensionContext) => {
		currentModel = (event as { model?: Model<Api> }).model ?? ctx.model;
		flush();
	});
	for (const eventName of ["message_start", "tool_execution_start", "turn_end"] as const) onRuntimeEvent(eventName, captureModel);
	onRuntimeEvent("session_shutdown", () => {
		disposed = true;
		try {
			watcher?.close();
		} catch {
			// Watcher teardown is best effort during process shutdown.
		}
		if (interval) clearIntervalImpl(interval);
	});
}
