import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import type { SubagentParamsLike } from "../../runs/foreground/subagent-executor.ts";
import { type Details } from "../../shared/types.ts";
import { SubagentParams } from "../schemas.ts";

export const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

export const SUBAGENT_RPC_METHODS = ["ping", "status", "spawn", "interrupt", "stop"] as const;
export type SubagentRpcMethod = typeof SUBAGENT_RPC_METHODS[number];

export interface SubagentRpcRequestEnvelope {
	version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
	requestId: string;
	method: SubagentRpcMethod;
	params?: unknown;
	source?: {
		extension?: string;
		[key: string]: unknown;
	};
}

export type SubagentRpcReplyEnvelope<T = unknown> = {
	version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
	requestId: string;
	method?: SubagentRpcMethod;
	success: true;
	data: T;
} | {
	version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
	requestId: string;
	method?: SubagentRpcMethod;
	success: false;
	error: {
		code: SubagentRpcErrorCode;
		message: string;
	};
};

type SubagentRpcErrorCode =
	| "invalid_request"
	| "invalid_params"
	| "unsupported_version"
	| "unsupported_method"
	| "no_active_session"
	| "execution_failed"
	| "not_found"
	| "invalid_state";

interface EventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

export interface RegisterSubagentRpcBridgeOptions {
	events: EventBus;
	getContext: () => ExtensionContext | null;
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

export class SubagentRpcError extends Error {
	readonly code: SubagentRpcErrorCode;

	constructor(code: SubagentRpcErrorCode, message: string) {
		super(message);
		this.name = "SubagentRpcError";
		this.code = code;
	}
}

export const subagentParamsValidator = Compile(SubagentParams);

export function subagentRpcReplyEvent(requestId: string): string {
	return `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}
