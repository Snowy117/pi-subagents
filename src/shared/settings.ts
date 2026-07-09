/**
 * Chain behavior, template resolution, and directory management.
 *
 * Barrel re-export hub: the public import surface (`.../shared/settings.ts`)
 * is preserved by wildcard re-exporting each domain submodule. Importers
 * are unchanged. Submodules are internal-only. ParallelTaskResult (type)
 * and aggregateParallelOutputs continue to be re-exported from
 * runs/shared/parallel-utils.
 */

export * from "./settings/chain-types.ts";
export * from "./settings/chain-directories.ts";
export * from "./settings/step-behavior.ts";
export * from "./settings/chain-instructions.ts";
export * from "./settings/chain-templates.ts";
export type { ParallelTaskResult } from "../runs/shared/parallel-utils.ts";
export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.ts";
