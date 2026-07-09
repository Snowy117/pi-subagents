/**
 * Type definitions for the subagent extension.
 *
 * Barrel re-export hub: the public import surface (`.../shared/types.ts`)
 * is preserved by wildcard re-exporting each domain submodule. Importers
 * are unchanged. Submodules are internal-only.
 *
 * output-truncation is re-exported selectively (truncateOutput only) so the
 * originally-private TruncationResult type does not enter the public surface.
 */

export * from "./types/budget-types.ts";
export * from "./types/control-types.ts";
export * from "./types/acceptance-types.ts";
export * from "./types/result-types.ts";
export * from "./types/async-types.ts";
export * from "./types/nested-types.ts";
export * from "./types/options-types.ts";
export * from "./types/constants.ts";
export * from "./types/temp-paths.ts";
export * from "./types/depth-guard.ts";
export * from "./types/parallel-config.ts";
export { truncateOutput } from "./types/output-truncation.ts";
export * from "./types/fork-task.ts";
