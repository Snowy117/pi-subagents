/**
 * Message parsing utilities: final-output extraction, display-item
 * projection, subagent-error detection, tool-arg preview, and text
 * extraction from heterogeneous content parts.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { DisplayItem, SingleResult, ErrorInfo } from "../types.ts";

/**
 * Get the final text output from a list of messages
 */
export function getFinalOutput(messages: Message[]): string {
	const validTextParts: string[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const hasAssistantError = ("errorMessage" in msg && typeof msg.errorMessage === "string" && msg.errorMessage.length > 0)
			|| ("stopReason" in msg && msg.stopReason === "error");
		if (hasAssistantError) continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j];
			if (part.type !== "text" || part.text.trim().length === 0) continue;
			validTextParts.push(part.text);
			if (/```acceptance-report\s*\n[\s\S]*?```/i.test(part.text)) return part.text;
			for (const match of part.text.matchAll(/```(?:json|jsonc|json5)\s*\n([\s\S]*?)```/gi)) {
				const body = match[1] ?? "";
				if (/"criteriaSatisfied"/.test(body) && /"(?:changedFiles|testsAddedOrUpdated|commandsRun|validationOutput|residualRisks|noStagedFiles|diffSummary|reviewFindings|manualNotes)"/.test(body)) {
					return part.text;
				}
			}
			if (/ACCEPTANCE_REPORT\s*:/i.test(part.text)) return part.text;
		}
	}
	return validTextParts[0] ?? "";
}

export function getSingleResultOutput(result: Pick<SingleResult, "finalOutput" | "messages">): string {
	return result.finalOutput ?? getFinalOutput(result.messages ?? []);
}

/**
 * Extract display items (text and tool calls) from messages
 */
export function getDisplayItems(messages: Message[] | undefined): DisplayItem[] {
	if (!messages || messages.length === 0) return [];
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "tool", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

/**
 * Detect errors in subagent execution from messages (only errors with no subsequent success)
 */
export function detectSubagentError(messages: Message[]): ErrorInfo {
	let lastAssistantTextIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const hasText = Array.isArray(msg.content) && msg.content.some(
				(c) => c.type === "text" && "text" in c && typeof c.text === "string" && c.text.trim().length > 0,
			);
			if (hasText) {
				lastAssistantTextIndex = i;
				break;
			}
		}
	}

	const scanStart = lastAssistantTextIndex >= 0 ? lastAssistantTextIndex + 1 : 0;

	for (let i = messages.length - 1; i >= scanStart; i--) {
		const msg = messages[i];
		if (msg.role !== "toolResult") continue;
		const toolName = "toolName" in msg && typeof msg.toolName === "string" ? msg.toolName : undefined;
		const isError = "isError" in msg && msg.isError === true;

		if (isError) {
			const text = msg.content.find((c) => c.type === "text");
			const details = text && "text" in text ? text.text : undefined;
			const exitMatch = details?.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
			return {
				hasError: true,
				exitCode: exitMatch ? parseInt(exitMatch[1], 10) : 1,
				errorType: toolName || "tool",
				details: details?.slice(0, 200),
			};
		}

		if (toolName !== "bash") continue;

		const text = msg.content.find((c) => c.type === "text");
		if (!text || !("text" in text)) continue;
		const output = text.text;

		const exitMatch = output.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
		if (exitMatch) {
			const code = parseInt(exitMatch[1], 10);
			if (code !== 0) {
				return { hasError: true, exitCode: code, errorType: "bash", details: output.slice(0, 200) };
			}
		}

		// NOTE: These patterns can match legitimate output (grep results, logs,
		// testing). With the assistant-message check above, most false positives
		// are mitigated since the agent will have responded after routine errors.
		const fatalPatterns = [
			/command not found/i,
			/permission denied/i,
			/no such file or directory/i,
			/segmentation fault/i,
			/killed|terminated/i,
			/out of memory/i,
			/connection refused/i,
			/timeout/i,
		];
		for (const pattern of fatalPatterns) {
			if (pattern.test(output)) {
				return { hasError: true, exitCode: 1, errorType: "bash", details: output.slice(0, 200) };
			}
		}
	}

	return { hasError: false };
}

/**
 * Extract a preview of tool arguments for display
 */
export function extractToolArgsPreview(args: Record<string, unknown>): string {
	const truncatePreview = (value: string, maxLength: number): string =>
		value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;

	const stringifyPreviewValue = (value: unknown): string | undefined => {
		if (typeof value === "string" && value.trim().length > 0) return value;
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		return undefined;
	};

	const previewArray = (value: unknown): string | undefined => {
		if (!Array.isArray(value) || value.length === 0) return undefined;
		const first = stringifyPreviewValue(value[0]);
		if (!first) return undefined;
		const suffix = value.length > 1 ? ` (+${value.length - 1} more)` : "";
		return `${first}${suffix}`;
	};

	// Handle MCP tool calls - show server/tool info
	if (args.tool && typeof args.tool === "string") {
		const server = args.server && typeof args.server === "string" ? `${args.server}/` : "";
		const toolArgs = args.args && typeof args.args === "string" ? ` ${args.args.slice(0, 40)}` : "";
		return `${server}${args.tool}${toolArgs}`;
	}

	const queriesPreview = previewArray(args.queries);
	if (queriesPreview) return truncatePreview(queriesPreview, 60);
	if (typeof args.query === "string" && args.query.trim().length > 0) return truncatePreview(args.query, 60);
	if (typeof args.workflow === "string" && args.workflow.trim().length > 0) return `workflow=${truncatePreview(args.workflow, 48)}`;

	if (typeof args.url === "string" && args.url.trim().length > 0) return truncatePreview(args.url, 60);
	const urlsPreview = previewArray(args.urls);
	if (urlsPreview) return truncatePreview(urlsPreview, 60);
	if (typeof args.prompt === "string" && args.prompt.trim().length > 0) return truncatePreview(args.prompt, 60);

	const previewKeys = ["command", "path", "file_path", "pattern", "query", "url", "task", "describe", "search"];
	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return truncatePreview(value, 60);
		}
	}

	// Fallback: show first string value found
	for (const [key, value] of Object.entries(args)) {
		const arrayPreview = previewArray(value);
		if (arrayPreview) return `${key}=${truncatePreview(arrayPreview, 50)}`;
		if (typeof value === "string" && value.length > 0) {
			const preview = truncatePreview(value, 50);
			return `${key}=${preview}`;
		}
	}
	return "";
}

/**
 * Extract text content from various message content formats
 */
export function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	// Handle string content directly
	if (typeof content === "string") return content;
	// Handle array content
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object") {
			// Handle { type: "text", text: "..." }
			if ("type" in part && part.type === "text" && "text" in part) {
				texts.push(String(part.text));
			}
			// Handle { type: "tool_result", content: "..." }
			else if ("type" in part && part.type === "tool_result" && "content" in part) {
				const inner = extractTextFromContent(part.content);
				if (inner) texts.push(inner);
			}
			// Handle { text: "..." } without type
			else if ("text" in part) {
				texts.push(String(part.text));
			}
		}
	}
	return texts.join("\n");
}
