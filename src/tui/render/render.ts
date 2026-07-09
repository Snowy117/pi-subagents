/**
 * External-dependency facade for the render/ submodules.
 *
 * Centralizes the value imports from @earendil-works/pi-coding-agent and
 * @earendil-works/pi-tui so every submodule resolves the same module
 * instance. This module's path ends in `/render.ts`, which is what the
 * test loader (test/support/ts-loader.mjs) keys its render shims on; the
 * original monolithic render.ts satisfied that by importing these values
 * directly, and this facade preserves that resolution path after the
 * split. Internal-only — not part of the render.ts public barrel surface.
 */
export { getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
export { Container, Markdown, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
