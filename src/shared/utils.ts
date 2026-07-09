/**
 * General utility functions for the subagent extension.
 *
 * Barrel re-export hub: the public import surface (`.../shared/utils.ts`)
 * is preserved by wildcard re-exporting each domain submodule. Importers
 * are unchanged. Submodules are internal-only. mapConcurrent continues to
 * be re-exported from runs/shared/parallel-utils.
 */

export * from "./utils/fs-paths.ts";
export * from "./utils/status-reader.ts";
export * from "./utils/output-tail.ts";
export * from "./utils/messages.ts";
export * from "./utils/result-aggregation.ts";
export * from "./utils/result-compaction.ts";
export { mapConcurrent } from "../runs/shared/parallel-utils.ts";
