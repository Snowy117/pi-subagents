export type ConversationMarkerType =
	| "child_ready"
	| "child_settled"
	| "child_closed"
	| "child_unavailable"
	| "pong"
	| "relay_reset";

export interface ConversationMarker {
	type: ConversationMarkerType;
	/** Registry key ("runId/flatIndex") of the child the marker describes;
	 *  relay_reset uses the stepKey (no registry key exists for a writer). */
	key: string;
	/** stepKey ("flatIndex-agent"); stamped by the relay writer when absent. */
	stepKey?: string;
	/** Epoch ms; stamped by the relay writer when absent. */
	ts?: number;
	/** child_closed: exit/signal/spawn reason; child_unavailable: miss reason. */
	reason?: string;
	/** pong: the ping request id it answers. */
	requestId?: string;
	[key: string]: unknown;
}

/** The optional per-child relay hook `runPiStreaming` consumes. */
export interface ConversationRelayHook {
	/** stepKey this hook relays ("flatIndex-agent", see resolveConversationStepKey). */
	readonly stepKey: string;
	/** Relay one raw child stdout line verbatim (LF framing preserved). */
	appendParsedLine(line: string): void;
	/** Append a synthetic lifecycle marker to the relay. */
	appendMarker(marker: ConversationMarker): void;
	/** Current byte offset consumed from `<stepKey>.requests.jsonl`. */
	requestsOffset(): number;
}

/** Validated parent→runner request record (forwarded verbatim to the child). */
export interface ConversationRequest {
	id: string;
	ts: number;
	type: "prompt" | "get_commands" | "ping"
		| "abort" | "get_state" | "set_model" | "cycle_model" | "get_available_models"
		| "set_thinking_level" | "cycle_thinking_level" | "get_available_thinking_levels";
	message?: string;
	streamingBehavior?: unknown;
	images?: unknown;
	[key: string]: unknown;
}