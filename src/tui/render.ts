/**
 * Rendering functions for subagent results.
 *
 * Barrel re-export hub: the public import surface (`.../tui/render.ts`)
 * is preserved. Only the five originally-exported names are re-exported;
 * every other submodule is internal-only, so importers are unchanged.
 */
export { clearLegacyResultAnimationTimer } from "./render/glyph-animation.ts";
export { widgetRenderKey } from "./render/widget-core.ts";
export { buildWidgetLines, renderWidget } from "./render/widget-render.ts";
export { renderSubagentResult } from "./render/result-render.ts";
