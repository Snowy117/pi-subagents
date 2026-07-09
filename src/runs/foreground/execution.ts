/**
 * Foreground single-subagent execution (barrel).
 *
 * Implementation lives in ./execution/*. Submodules are internal-only; this
 * barrel re-exports the original public symbol (runSync) unchanged so every
 * existing `import … from "…/execution.ts"` keeps resolving.
 */

export { runSync } from "./execution/run-sync.ts";
