/**
 * Native supervisor channel — parent-side reply handling, the parent intercom
 * tool, and the polling channel factory (`createNativeSupervisorChannel`).
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { IntercomEventBus, SubagentState } from "../../shared/types.ts";
import { INTERCOM_DETACH_REQUEST_EVENT } from "../../shared/types.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { resolveRunLiveness, wrapSystemMessage } from "../../shared/system-message-wrap.ts";
import type {
	IntercomParams,
	PendingSupervisorRequest,
	SupervisorReply,
} from "./types.ts";
import {
	CHANNEL_POLL_MS,
	IntercomParamsSchema,
	NATIVE_SUPERVISOR_TOOL_NAME,
	STALE_EMPTY_CHANNEL_CLEANUP_INTERVAL_MS,
	SUPERVISOR_CHANNEL_ROOT,
} from "./types.ts";
import { removeRequestFile, replyPath } from "./channel-paths.ts";
import {
	cleanupRequestLifecycle,
	cleanupStaleEmptySupervisorChannels,
	listRequestFiles,
	parseRequestFile,
	refreshPendingRequests,
	requestLifecycle,
	requestMatchesContext,
} from "./request-lifecycle.ts";
import { hasTool } from "./child-client.ts";

function formatPendingLine(request: PendingSupervisorRequest): string {
	const replyHint = request.expectsReply ? ` Reply: ${NATIVE_SUPERVISOR_TOOL_NAME}({ action: "reply", replyTo: "${request.id}", message: "..." })` : "";
	return `- ${request.id}: ${request.agent} [${request.runId}#${request.childIndex}] ${request.reason}.${replyHint}`;
}

function requestVisibleText(request: PendingSupervisorRequest): string {
	const lines = [request.message];
	if (request.expectsReply) {
		lines.push("", `Reply with: ${NATIVE_SUPERVISOR_TOOL_NAME}({ action: "reply", replyTo: "${request.id}", message: "..." })`);
	}
	return lines.join("\n");
}

function writeReply(request: PendingSupervisorRequest, message: string): void {
	if (!message.trim()) throw new Error("message is required for supervisor replies.");
	const reply: SupervisorReply = {
		type: "subagent.supervisor.reply",
		requestId: request.id,
		createdAt: Date.now(),
		message: message.trim(),
	};
	writeAtomicJson(replyPath(request.channelDir, request.id), reply);
	removeRequestFile(request.requestFile);
}

function resolvePendingRequest(pending: Map<string, PendingSupervisorRequest>, params: IntercomParams): PendingSupervisorRequest {
	if (params.replyTo) {
		const request = pending.get(params.replyTo);
		if (!request) throw new Error(`No pending supervisor request found for replyTo '${params.replyTo}'.`);
		return request;
	}
	const requests = [...pending.values()].filter((request) => request.expectsReply);
	if (params.to) {
		const normalizedTo = params.to.toLowerCase();
		const matches = requests.filter((request) =>
			request.id.toLowerCase().startsWith(normalizedTo)
			|| request.agent.toLowerCase() === normalizedTo
			|| request.childTarget?.toLowerCase() === normalizedTo,
		);
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) throw new Error(`Multiple pending supervisor requests match '${params.to}'. Use replyTo.`);
	}
	if (requests.length === 1) return requests[0]!;
	if (requests.length === 0) throw new Error("No pending supervisor requests need a reply.");
	throw new Error("Multiple pending supervisor requests need replies. Use replyTo.");
}

function publicPendingRequests(pending: Map<string, PendingSupervisorRequest>): Array<Record<string, unknown>> {
	return [...pending.values()].map((request) => ({
		id: request.id,
		runId: request.runId,
		agent: request.agent,
		childIndex: request.childIndex,
		reason: request.reason,
		expectsReply: request.expectsReply,
	}));
}

function buildParentIntercomTool(pending: Map<string, PendingSupervisorRequest>, state: SubagentState, name = "intercom"): ToolDefinition<typeof IntercomParamsSchema, Record<string, unknown>> {
	return {
		name,
		label: name === "intercom" ? "Intercom" : "Subagent Supervisor",
		description: name === "intercom"
			? "Native pi-subagents supervisor channel. Use reply/pending/status to answer child subagent requests."
			: "Native pi-subagents supervisor channel. Use reply/pending/status to answer child subagent requests without overriding pi-intercom.",
		parameters: IntercomParamsSchema,
		async execute(_id, params) {
			refreshPendingRequests(pending, state, state.lastUiContext ?? undefined);
			const input = params as IntercomParams;
			if (input.action === "status") {
				return { content: [{ type: "text", text: `Native supervisor channel active. Pending replies: ${pending.size}.` }], details: { active: true, pending: pending.size, root: SUPERVISOR_CHANNEL_ROOT } };
			}
			if (input.action === "pending" || input.action === "list") {
				const lines = [...pending.values()].filter((request) => request.expectsReply).map(formatPendingLine);
				return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No pending supervisor requests." }], details: { pending: publicPendingRequests(pending) } };
			}
			if (input.action === "reply") {
				const request = resolvePendingRequest(pending, input);
				writeReply(request, input.message ?? "");
				pending.delete(request.id);
				return { content: [{ type: "text", text: `Replied to supervisor request ${request.id}.` }], details: { replyTo: request.id, runId: request.runId, agent: request.agent } };
			}
			if (input.action === "send" || input.action === "ask") {
				throw new Error("Native pi-subagents intercom currently handles supervisor replies. Child agents initiate asks with contact_supervisor.");
			}
			throw new Error(`Unsupported intercom action: ${input.action}`);
		},
	};
}

export function createNativeSupervisorChannel(pi: ExtensionAPI, state: SubagentState): { start: () => void; dispose: () => void; pending: Map<string, PendingSupervisorRequest> } {
	const pending = new Map<string, PendingSupervisorRequest>();
	const seenFiles = new Set<string>();
	let poller: ReturnType<typeof setInterval> | undefined;
	let lastStaleCleanupAt = 0;

	const registerParentTools = (): void => {
		if (!hasTool(pi, NATIVE_SUPERVISOR_TOOL_NAME)) pi.registerTool(buildParentIntercomTool(pending, state, NATIVE_SUPERVISOR_TOOL_NAME));
		if (!hasTool(pi, "intercom")) pi.registerTool(buildParentIntercomTool(pending, state));
	};

	const cleanupStaleChannelsIfDue = (): void => {
		const nowMs = Date.now();
		if (nowMs - lastStaleCleanupAt < STALE_EMPTY_CHANNEL_CLEANUP_INTERVAL_MS) return;
		lastStaleCleanupAt = nowMs;
		try {
			cleanupStaleEmptySupervisorChannels(nowMs);
		} catch {
			// Supervisor delivery must not fail because best-effort temp cleanup failed.
		}
	};

	const poll = (): void => {
		cleanupStaleChannelsIfDue();
		const ctx = state.lastUiContext;
		if (!ctx) return;
		refreshPendingRequests(pending, state, ctx);
		const now = Date.now();
		for (const { channelDir, file } of listRequestFiles()) {
			if (seenFiles.has(file)) continue;
			const request = parseRequestFile(file, channelDir);
			if (!request || !requestMatchesContext(request, state, ctx)) continue;
			const lifecycle = requestLifecycle(request, state, undefined, now);
			if (lifecycle !== "pending") {
				seenFiles.add(file);
				cleanupRequestLifecycle(request, lifecycle);
				continue;
			}
			seenFiles.add(file);
			if (request.expectsReply) pending.set(request.id, request);
			else {
				removeRequestFile(request.requestFile);
			}
			const runLiveness = resolveRunLiveness(state, request.runId);
			const wrapped = wrapSystemMessage(requestVisibleText(request), {
				source: `supervisor request (${request.reason})`,
				runLiveness,
				sentAt: request.createdAt,
			});
			pi.sendMessage({
				customType: "subagent_supervisor_request",
				content: wrapped,
				display: true,
				details: {
					id: request.id,
					reason: request.reason,
					expectsReply: request.expectsReply,
					runId: request.runId,
					agent: request.agent,
					childIndex: request.childIndex,
				},
			});
			if (request.expectsReply) {
				(pi as { events?: IntercomEventBus }).events?.emit(INTERCOM_DETACH_REQUEST_EVENT, {
					requestId: request.id,
					runId: request.runId,
					agent: request.agent,
					childIndex: request.childIndex,
				});
			}
		}
	};

	return {
		start: () => {
			if (poller) return;
			registerParentTools();
			poll();
			poller = setInterval(poll, CHANNEL_POLL_MS);
			poller.unref?.();
		},
		dispose: () => {
			if (poller) clearInterval(poller);
			poller = undefined;
			pending.clear();
			seenFiles.clear();
		},
		pending,
	};
}
