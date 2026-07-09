/**
 * Result intercom: build, deliver, and render subagent result messages.
 *
 * Barrel re-export hub. The public import surface
 * (`.../intercom/result-intercom.ts`) is preserved exactly via named
 * re-exports. The payload submodule additionally exports private status helpers
 * (`countStatuses`, `formatStatusCounts`) consumed by the delivery submodule,
 * so wildcard re-export is intentionally avoided to keep those helpers off the
 * public surface. Importers are unchanged. Submodules are internal-only.
 */

export {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	compactNestedResultChildren,
	resolveSubagentResultStatus,
} from "./result-intercom-payload.ts";
export {
	deliverSubagentIntercomMessageEvent,
	deliverSubagentResultIntercomEvent,
	formatSubagentResultReceipt,
	stripDetailsOutputsForIntercomReceipt,
} from "./result-intercom-delivery.ts";
