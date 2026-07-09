/**
 * Native supervisor channel — type definitions, runtime schemas, and shared
 * constants.
 */

import * as path from "node:path";
import { Type } from "typebox";
import { POLL_INTERVAL_MS, TEMP_ROOT_DIR } from "../../shared/types.ts";

export const SUPERVISOR_CHANNEL_ROOT = path.join(TEMP_ROOT_DIR, "supervisor-channels");
export const REQUESTS_DIR = "requests";
export const REPLIES_DIR = "replies";
export const NATIVE_SUPERVISOR_TOOL_NAME = "subagent_supervisor";
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
export const CHANNEL_POLL_MS = Math.min(POLL_INTERVAL_MS, 500);
export const STALE_EMPTY_CHANNEL_AGE_MS = 60 * 1000;
export const STALE_EMPTY_CHANNEL_CLEANUP_INTERVAL_MS = 60 * 1000;

export type SupervisorReason = "need_decision" | "interview_request" | "progress_update";

export interface SupervisorRequest {
	type: "subagent.supervisor.request";
	id: string;
	createdAt: number;
	expiresAt?: number;
	reason: SupervisorReason;
	message: string;
	expectsReply: boolean;
	orchestratorTarget?: string;
	orchestratorSessionId?: string;
	runId: string;
	agent: string;
	childIndex: number;
	childTarget?: string;
	interview?: unknown;
}

export interface PendingSupervisorRequest extends SupervisorRequest {
	channelDir: string;
	requestFile: string;
}

export interface SupervisorReply {
	type: "subagent.supervisor.reply";
	requestId: string;
	createdAt: number;
	message: string;
}

export interface ContactSupervisorParams {
	reason: SupervisorReason;
	message?: string;
	interview?: unknown;
}

export interface IntercomParams {
	action: "list" | "send" | "ask" | "reply" | "pending" | "status";
	to?: string;
	message?: string;
	replyTo?: string;
}

export const ContactSupervisorParamsSchema = Type.Object({
	reason: Type.String({ enum: ["need_decision", "interview_request", "progress_update"] }),
	message: Type.Optional(Type.String()),
	interview: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true })),
}, { additionalProperties: false });

export const IntercomParamsSchema = Type.Object({
	action: Type.String({ enum: ["list", "send", "ask", "reply", "pending", "status"] }),
	to: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	replyTo: Type.Optional(Type.String()),
}, { additionalProperties: false });

export type SupervisorRequestLifecycle = "pending" | "resolved" | "expired" | "inactive" | "missing" | "wrong-session";
