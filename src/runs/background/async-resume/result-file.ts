import * as fs from "node:fs";
import type { AsyncStatus } from "../../../shared/types.ts";

interface AsyncResultFile {
	id?: string;
	runId?: string;
	agent?: string;
	mode?: string;
	state?: string;
	success?: boolean;
	cwd?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	results?: Array<{ agent?: string; success?: boolean; sessionFile?: string; intercomTarget?: string; model?: string; thinking?: string }>;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ensureObject(value: unknown, source: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Async result file '${source}' must contain a JSON object.`);
	}
	return value as Record<string, unknown>;
}

function validateOptionalString(value: Record<string, unknown>, field: string, source: string, displayField = field): string | undefined {
	const fieldValue = value[field];
	if (fieldValue === undefined) return undefined;
	if (typeof fieldValue !== "string") throw new Error(`Invalid async result file '${source}': ${displayField} must be a string.`);
	return fieldValue;
}

function validateResultFile(value: unknown, resultPath: string): AsyncResultFile {
	const data = ensureObject(value, resultPath);
	const resultsValue = data.results;
	let results: AsyncResultFile["results"];
	if (resultsValue !== undefined) {
		if (!Array.isArray(resultsValue)) throw new Error(`Invalid async result file '${resultPath}': results must be an array.`);
		results = resultsValue.map((entry, index) => {
			const child = ensureObject(entry, `${resultPath} results[${index}]`);
			const agent = validateOptionalString(child, "agent", resultPath, `results[${index}].agent`);
			const sessionFile = validateOptionalString(child, "sessionFile", resultPath, `results[${index}].sessionFile`);
			const intercomTarget = validateOptionalString(child, "intercomTarget", resultPath, `results[${index}].intercomTarget`);
			const model = validateOptionalString(child, "model", resultPath, `results[${index}].model`);
			const thinking = validateOptionalString(child, "thinking", resultPath, `results[${index}].thinking`);
			const success = child.success;
			if (success !== undefined && typeof success !== "boolean") throw new Error(`Invalid async result file '${resultPath}': results[${index}].success must be a boolean.`);
			return { agent, sessionFile, intercomTarget, model, thinking, ...(typeof success === "boolean" ? { success } : {}) };
		});
	}
	const success = data.success;
	if (success !== undefined && typeof success !== "boolean") throw new Error(`Invalid async result file '${resultPath}': success must be a boolean.`);
	return {
		id: validateOptionalString(data, "id", resultPath),
		runId: validateOptionalString(data, "runId", resultPath),
		agent: validateOptionalString(data, "agent", resultPath),
		mode: validateOptionalString(data, "mode", resultPath),
		state: validateOptionalString(data, "state", resultPath),
		cwd: validateOptionalString(data, "cwd", resultPath),
		sessionFile: validateOptionalString(data, "sessionFile", resultPath),
		model: validateOptionalString(data, "model", resultPath),
		thinking: validateOptionalString(data, "thinking", resultPath),
		...(typeof success === "boolean" ? { success } : {}),
		...(results ? { results } : {}),
	};
}

export function readResultFile(resultPath: string): AsyncResultFile {
	let raw: string;
	try {
		raw = fs.readFileSync(resultPath, "utf-8");
	} catch (error) {
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return validateResultFile(JSON.parse(raw), resultPath);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Failed to parse async result file '${resultPath}': ${getErrorMessage(error)}`, {
				cause: error,
			});
		}
		throw error;
	}
}

export function resultState(result: AsyncResultFile): AsyncStatus["state"] {
	if (result.state === "complete" || result.state === "failed" || result.state === "paused" || result.state === "running" || result.state === "queued") {
		return result.state;
	}
	return result.success ? "complete" : "failed";
}
