# Async conversation bridge: cross-process RPC access to runner-owned children

## Problem

Foreground children are spawned by the parent extension process; the parent owns
their RPC stdin/stdout (`PersistentRpcChild`). Async children are spawned by
the **runner process** (`run-subagent.ts`), which owns their stdin/stdout and
its own `RpcChildRegistry`. The parent has no process handle, so selecting an
async child in `/subagents` currently falls back to the legacy `SteerViewComponent`
overlay (custom Input + custom rendering).

`src/extension/index.ts` `getResidentChild`:
```ts
if (kind !== "foreground" || !runId || !indexText) return undefined;
// Async children ... resolved via a cross-process bridge (Phase 5), not here.
```

## Process topology (verified 2026-08-01)

```
parent extension process (interactive pi 0.83.0)
 ├─ foreground child:  spawn ──stdio pipe──▶ pi --mode rpc      (parent owns channel)
 └─ async run: spawn ──▶ runner process (run-subagent.ts)
                         └─ per step: spawn ──stdio pipe──▶ pi --mode rpc  (runner owns channel)
                            child stdout parsed at run-pi-streaming.ts:223-226 (line-buffered);
                            raw lines collected in rawStdoutLines (line 62,100)
```

- Runner exits after `finalizeRun` + `persistentChildRegistry.closeAll("graceful")`
  (`run-subagent.ts` tail). Graceful close = stdin EOF → Pi persists session.
- Runner-scoped registry: children of settled successful steps stay resident
  during the run; settled failed children are unregistered+closed
  (`run-pi-streaming.ts:110-138`).
- Parent already talks to the runner/children via files only:
  `asyncDir/control/` (interrupt/timeout/steer requests, `control-channel.ts`).
- Status/PIDs: `asyncDir/status.json` (`.pid` = runner pid) written by the
  runner; `listAsyncRuns` surfaces states queued/running/complete/failed/paused.

## Bridge design (file transport, mirrors control-channel patterns)

```
asyncDir/conversation/
  <stepKey>.requests.jsonl    # parent → runner (appended, atomic; runner tracks read offset)
  <stepKey>.stdout.jsonl      # runner → parent (raw child RPC stdout lines + lifecycle markers)
  <stepKey>.active            # parent heartbeat {ts} (rewritten ~every 5s while conversing)
  <stepKey>.relay-cap.jsonl   # (optional) truncation marker when relay exceeds cap
```
`stepKey` = `${stepIndex}-${agent}` (matches registry key `runId/stepIndex/agent`).

### Parent → runner requests (JSONL, { id, ts, type, ... })
- `{ id, ts, type:"prompt", message, streamingBehavior?, images? }` — forwarded
  verbatim to the child RPC stdin (the child's own RPC protocol).
- `{ id, ts, type:"get_commands" }` — forwarded; response arrives on the child
  stdout and is relayed back through stdout.jsonl (viewer correlates by id,
  identical to foreground `refreshCommands`).
- `{ id, ts, type:"ping" }` — liveness probe (runner responds with a ping-a
  marker or the viewer falls back to reopen when the bridge is gone).

### Runner → parent relay (raw child stdout JSONL lines, one per file line)
The runner appends every parsed child stdout line (single writer). Synthetic
lifecycle markers are appended by the runner:
- `{ type:"child_ready", key }` (launched, bridge usable)
- `{ type:"child_settled", key }` (agent_settled observed)
- `{ type:"child_closed", key, reason }` (process closed/evicted)
- `{ type:"relay_reset", key }` (relay truncated to the current tail)

Why raw-mirror instead of transcript: the transcript (`child-transcript.ts`)
persists only finalized `message_end`/`tool_result_end` records; the live
stream contains `message_start`/`message_update`/`tool_execution_*` needed to
render streaming assistant text and tool-call arg updates the way the main view
does. The viewer feeds relay lines through the exact same parser as foreground
RPC stdout — byte-level symmetry.

Relay cap: if a relay file exceeds ~20 MiB, the runner truncates it and writes
`relay_reset` with the current tail (viewer drops its fed cursor and resyncs).

### Heartbeat + lifecycle (Q3=A: runner lingers after run end while conversing)
- While the host-editor mode is active on an async child, the parent rewrites
  `<stepKey>.active` (`{ ts }`) every ~5s; TTL = 30s.
- Runner eviction ticks treat a fresh-heartbeat child as conversing: excluded
  from idle eviction and overflow cap (mirroring the parent extension's
  `evictIdle/evictOverflow({ except })`).
- On `finalizeRun`: children with a fresh heartbeat are kept resident; the
  runner waits (max linger, e.g. 10 min) until heartbeat expires / the parent
  deletes `<stepKey>.active` (viewer close, target switch, session shutdown),
  then `closeAll("graceful")` and exit. Run results/status/notifications are
  produced at finalize exactly as today (only process exit is deferred).
- If the runner dies anyway (crash): bridge EOF → viewer sees `child_closed`
  / relay EOF; if the run is terminal and a session file exists, the viewer
  auto-reopens via `--session` (registry-guarded, single writer) and swaps the
  channel, preserving the in-memory conversation.

### Reopen race guard (terminal runs)
- `listAsyncRuns` can report "complete" while the runner is still closing
  children. Reopen (which spawns a new writer on the session) must wait until
  the runner pid is gone: `process.kill(status.pid, 0)` → ESRCH = gone.
  Bounded retry (e.g. up to 5s), then "continuity unavailable".
- The reopened child is a normal `RpcChild` in the parent registry (reopen
  bridge already guards one-entry-per-key).

## Why not a socket

- File-based matches every existing cross-process channel (control-channel,
  steer inbox, live transcripts) — crash-safe, no platform differences
  (Windows named pipes vs Unix sockets), no fd handoff, trivially debug-able.
- Latency: the viewer already polls transcript tails at 250ms; the relay is the
  same cadence. Streaming text is rendered at message boundaries anyway
  (see native-renderer-reuse.md), so 250ms adds no perceptible difference.
- Requests are human-rate (a submit per seconds); the requests.jsonl append has
  no throughput requirement.

## Conflicts / invariants

- Sole writer per channel: parent appends requests; runner consumes by offset;
  runner appends relay; viewer tails with a cursor. No two writers on the same
  file stream.
- Registry one-entry-per-key invariant extends across processes via the region
  of authority: while the runner owns a child, the parent never opens that
  session; the parent only reopens after the runner pid is dead.
- Bridge never bypasses the child as the sole session writer — the session file
  is untouched by both bridge and viewer.