/**
 * Native supervisor channel: filesystem-backed request/reply bridge between
 * child subagents and their supervisor session.
 *
 * Barrel re-export hub. The public import surface
 * (`.../intercom/native-supervisor-channel.ts`) is preserved exactly via named
 * re-exports: the original module exported only five symbols, while the
 * submodules additionally hold private helpers (types, schemas, path
 * utilities, request lifecycle, child/parent logic). Wildcard re-export would
 * leak those private helpers onto the public surface, so explicit named
 * re-exports are used to guarantee exported-symbol parity. Importers are
 * unchanged. Submodules are internal-only.
 */

export { NATIVE_SUPERVISOR_TOOL_NAME } from "./native-supervisor-channel/types.ts";
export { resolveSupervisorChannelDir, ensureSupervisorChannelDir } from "./native-supervisor-channel/channel-paths.ts";
export { registerNativeSupervisorClient } from "./native-supervisor-channel/child-client.ts";
export { createNativeSupervisorChannel } from "./native-supervisor-channel/parent-channel.ts";
