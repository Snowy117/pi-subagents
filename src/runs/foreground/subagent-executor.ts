/** Subagent executor (barrel). Implementation in ./executor/*. Submodules are
 *  internal-only; this re-exports the original public symbols unchanged:
 *  createSubagentExecutor, notifyForegroundDetachedCompletion, SubagentParamsLike. */

export { createSubagentExecutor } from "./executor/create-executor.ts";
export { notifyForegroundDetachedCompletion } from "./executor/foreground-notify.ts";
export type { SubagentParamsLike } from "./executor/types.ts";
