/**
 * Runner-side conversation bridge (Phase 4, async children) — file transport
 * that gives the parent extension live RPC access to runner-owned children.
 *
 * Layout (all files live under `<asyncDir>/conversation/`):
 *
 *   <stepKey>.stdout.jsonl   runner → parent: every parsed child stdout RPC
 *                            line + synthetic lifecycle markers (single writer)
 *   <stepKey>.requests.jsonl parent → runner: prompt/get_commands/ping records
 *   <stepKey>.active         parent heartbeat `{ ts }` (JSON, epoch ms)
 *
 * EXACT stepKey rule (the parent-side bridge MUST compute the same value):
 * `resolveConversationStepKey(stepIndex, agent)` returns
 * `${sanitize(stepIndex)}-${sanitize(agent)}` — the runner's flat step index
 * (statusPayload.steps position / SteerViewTarget.index), a dash, then the
 * agent name; both components sanitized with the artifact rule
 * `[^\w.-] -> "_"`. A numeric-first key makes parsing unambiguous even when
 * the agent contains dashes ("0-my_agent" can only parse as index 0).
 *
 * Relay marker records (JSONL in stdout.jsonl; the relay writer stamps
 * `stepKey` and `ts` when the caller omits them):
 *   { type:"child_ready",       key }   child launched + registered
 *   { type:"child_settled",     key }   agent_settled observed for the child
 *   { type:"child_closed",      key, reason }  process closed (exit/signal/eviction/spawn-error)
 *   { type:"child_unavailable", key, reason:"no-resident" }  request arrived with no resident child
 *   { type:"pong",              key, requestId }  answer to a ping request
 *   { type:"relay_reset",       key }  relay truncated at the 20 MiB cap; tail readers must resync
 * `key` is the registry key `runId/flatIndex`; markers also carry `stepKey`.
 *
 * Request records (parent appends to requests.jsonl, runner consumes from a
 * byte offset):
 *   { id, ts, type:"prompt",        message, streamingBehavior?, images? }
 *   { id, ts, type:"get_commands" }
 *   { id, ts, type:"ping" }
 * prompt/get_commands are forwarded verbatim to the child's RPC stdin; ping is
 * answered locally with a pong marker. The child remains the sole session-file
 * writer — the bridge never touches the session file.
 *
 * Lifecycle (Q3=A): while ≥1 stepKey has a fresh heartbeat the runner lingers
 * after finalize so conversing settled children stay resident; when all
 * heartbeats expire or are cleared the runner closes everything and exits.
 */

export * from "./conversation-bridge/paths.ts";
export * from "./conversation-bridge/heartbeat.ts";
export * from "./conversation-bridge/relay-writer.ts";
export * from "./conversation-bridge/requests-watcher.ts";
export * from "./conversation-bridge/types.ts";
export * from "./conversation-bridge/bridge.ts";