/** Chain execution (barrel). Implementation in ./chain-execution/*. Submodules are
 * internal-only; this re-exports the original public symbol (executeChain). */

export { executeChain } from "./chain-execution/execute-chain.ts";
