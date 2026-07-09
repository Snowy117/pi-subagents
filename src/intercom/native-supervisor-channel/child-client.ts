/**
 * Native supervisor channel — child-side client: reads subagent metadata,
 * formats outgoing supervisor requests, awaits replies, and registers the
 * child contact tools (`contact_supervisor`, `intercom` fallback).
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_TARGET_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../../runs/shared/pi-args.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type {
	ContactSupervisorParams,
	IntercomParams,
	SupervisorReason,
	SupervisorReply,
	SupervisorRequest,
} from "./types.ts";
import {
	ContactSupervisorParamsSchema,
	DEFAULT_ASK_TIMEOUT_MS,
	IntercomParamsSchema,
	MAX_MESSAGE_BYTES,
} from "./types.ts";
import {
	ensureSupervisorChannelDir,
	removeRequestFile,
	replyPath,
	requestPath,
} from "./channel-paths.ts";

function readTextEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function readChildMetadata(): {
	channelDir: string;
	runId: string;
	agent: string;
	childIndex: number;
	orchestratorTarget?: string;
	orchestratorSessionId?: string;
	childTarget?: string;
} | undefined {
	const channelDir = readTextEnv(SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV);
	const runId = readTextEnv(SUBAGENT_RUN_ID_ENV);
	const agent = readTextEnv(SUBAGENT_CHILD_AGENT_ENV);
	const rawIndex = readTextEnv(SUBAGENT_CHILD_INDEX_ENV);
	const orchestratorSessionId = readTextEnv(SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV);
	if (!channelDir || !runId || !agent || !orchestratorSessionId || rawIndex === undefined || !/^\d+$/.test(rawIndex)) return undefined;
	return {
		channelDir,
		runId,
		agent,
		childIndex: Number(rawIndex),
		orchestratorTarget: readTextEnv(SUBAGENT_ORCHESTRATOR_TARGET_ENV),
		orchestratorSessionId,
		childTarget: readTextEnv("PI_SUBAGENT_INTERCOM_SESSION_NAME"),
	};
}

function reasonHeading(reason: SupervisorReason): string {
	if (reason === "interview_request") return "Subagent requests a structured supervisor interview.";
	if (reason === "progress_update") return "Subagent progress update.";
	return "Subagent needs a supervisor decision.";
}

function formatChildMessage(input: {
	reason: SupervisorReason;
	message?: string;
	interview?: unknown;
	runId: string;
	agent: string;
	childIndex: number;
	childTarget?: string;
}): string {
	const lines = [
		reasonHeading(input.reason),
		`Run: ${input.runId}`,
		`Agent: ${input.agent}`,
		`Child index: ${input.childIndex}`,
	];
	if (input.childTarget) lines.push(`Child intercom target: ${input.childTarget}`);
	lines.push("");
	if (input.message?.trim()) lines.push(input.message.trim());
	if (input.reason === "interview_request") {
		lines.push(
			"",
			"Structured response requested. Reply with JSON, optionally fenced in ```json, matching the requested interview shape.",
		);
		if (input.interview !== undefined) lines.push(JSON.stringify(input.interview, null, "\t"));
	}
	return lines.join("\n").trimEnd();
}

function parseStructuredReply(message: string): { value?: unknown; error?: string } {
	const trimmed = message.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
	try {
		return { value: JSON.parse(fenced ?? trimmed) };
	} catch (error) {
		return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
	}
}

function askTimeoutMs(): number {
	const parsed = Number(process.env.PI_INTERCOM_ASK_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ASK_TIMEOUT_MS;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Supervisor request cancelled."));
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error("Supervisor request cancelled."));
		};
		timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForReply(channelDir: string, requestId: string, deadline: number, signal?: AbortSignal): Promise<SupervisorReply> {
	const file = replyPath(channelDir, requestId);
	while (Date.now() <= deadline) {
		if (signal?.aborted) throw new Error("Supervisor request cancelled.");
		if (fs.existsSync(file)) {
			const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SupervisorReply>;
			if (parsed.type === "subagent.supervisor.reply" && parsed.requestId === requestId && typeof parsed.message === "string") {
				return parsed as SupervisorReply;
			}
		}
		await delay(250, signal);
	}
	throw new Error("Timed out waiting for supervisor reply.");
}

async function sendSupervisorRequest(params: ContactSupervisorParams, signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
	const metadata = readChildMetadata();
	if (!metadata) throw new Error("Native supervisor channel is not available for this subagent.");
	if (params.reason !== "progress_update" && !params.message?.trim() && params.reason !== "interview_request") {
		throw new Error("message is required for supervisor decisions.");
	}
	ensureSupervisorChannelDir(metadata.channelDir);
	const requestId = randomUUID();
	const expectsReply = params.reason !== "progress_update";
	const createdAt = Date.now();
	const replyDeadline = createdAt + askTimeoutMs();
	const expiresAt = expectsReply ? replyDeadline : undefined;
	const message = formatChildMessage({ ...metadata, reason: params.reason, message: params.message, interview: params.interview });
	const request: SupervisorRequest = {
		type: "subagent.supervisor.request",
		id: requestId,
		createdAt,
		...(expiresAt !== undefined ? { expiresAt } : {}),
		reason: params.reason,
		message,
		expectsReply,
		...(metadata.orchestratorTarget ? { orchestratorTarget: metadata.orchestratorTarget } : {}),
		...(metadata.orchestratorSessionId ? { orchestratorSessionId: metadata.orchestratorSessionId } : {}),
		runId: metadata.runId,
		agent: metadata.agent,
		childIndex: metadata.childIndex,
		...(metadata.childTarget ? { childTarget: metadata.childTarget } : {}),
		...(params.interview !== undefined ? { interview: params.interview } : {}),
	};
	const serialized = JSON.stringify(request, null, "\t");
	if (Buffer.byteLength(serialized, "utf-8") > MAX_MESSAGE_BYTES) throw new Error("Supervisor request is too large.");
	writeAtomicJson(requestPath(metadata.channelDir, requestId), request);

	if (!expectsReply) {
		return {
			content: [{ type: "text", text: "Supervisor progress update queued." }],
			details: { delivered: true, requestId, reason: params.reason },
		};
	}

	try {
		const reply = await waitForReply(metadata.channelDir, requestId, replyDeadline, signal);
		const details: Record<string, unknown> = { requestId, reason: params.reason };
		if (params.reason === "interview_request") {
			const structured = parseStructuredReply(reply.message);
			if (structured.error) details.structuredReplyParseError = structured.error;
			else details.structuredReply = structured.value;
		}
		return {
			content: [{ type: "text", text: `**Reply from supervisor:**\n${reply.message}` }],
			details,
		};
	} catch (error) {
		removeRequestFile(requestPath(metadata.channelDir, requestId));
		throw error;
	}
}

export function hasTool(pi: ExtensionAPI, name: string): boolean {
	try {
		return pi.getAllTools?.().some((tool: { name?: unknown }) => tool.name === name) === true;
	} catch {
		return false;
	}
}

export function registerNativeSupervisorClient(pi: ExtensionAPI, options: { includeIntercomFallback?: boolean } = {}): void {
	if (!readChildMetadata()) return;
	const includeIntercomFallback = options.includeIntercomFallback !== false;
	if (!hasTool(pi, "contact_supervisor")) {
		const tool: ToolDefinition<typeof ContactSupervisorParamsSchema, Record<string, unknown>> = {
			name: "contact_supervisor",
			label: "Contact Supervisor",
			description: "Contact the parent/supervisor session for a blocking decision, structured interview, or progress update.",
			parameters: ContactSupervisorParamsSchema,
			execute(_id, params, signal) {
				return sendSupervisorRequest(params as ContactSupervisorParams, signal);
			},
		};
		pi.registerTool(tool);
	}
	if (includeIntercomFallback && !hasTool(pi, "intercom")) {
		const tool: ToolDefinition<typeof IntercomParamsSchema, Record<string, unknown>> = {
			name: "intercom",
			label: "Intercom",
			description: "Native supervisor-channel intercom fallback for subagents. Prefer contact_supervisor when available.",
			parameters: IntercomParamsSchema,
			async execute(_id, params, signal) {
				const action = (params as IntercomParams).action;
				if (action === "status") return { content: [{ type: "text", text: "Native supervisor channel is active." }], details: { active: true } };
				if (action === "list") return { content: [{ type: "text", text: "Supervisor session available through contact_supervisor." }], details: { sessions: [] } };
				if (action === "send") return sendSupervisorRequest({ reason: "progress_update", message: (params as IntercomParams).message ?? "" }, signal);
				if (action === "ask") return sendSupervisorRequest({ reason: "need_decision", message: (params as IntercomParams).message ?? "" }, signal);
				throw new Error("Native child intercom supports status, list, send, and ask. Use parent intercom reply from the supervisor session.");
			},
		};
		pi.registerTool(tool);
	}
}
