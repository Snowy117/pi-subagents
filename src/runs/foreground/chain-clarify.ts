/**
 * Chain Clarification TUI Component (barrel).
 *
 * Shows templates and resolved behaviors for each step in a chain.
 * Supports runtime editing of templates, output paths, reads lists, and progress toggle.
 *
 * Implementation lives in ./chain-clarify/*. Submodules are internal-only; this
 * barrel re-exports the original public symbols unchanged so every existing
 * `import … from "…/chain-clarify.ts"` keeps resolving.
 *
 * Note: `ChainClarifyComponent` is an accepted R1 line-budget residual (a single
 * cohesive `private`-state class); see `./chain-clarify/chain-clarify-component.ts`.
 */

export type { BehaviorOverride, ChainClarifyResult } from "./chain-clarify/types.ts";
export { ChainClarifyComponent } from "./chain-clarify/chain-clarify-component.ts";
