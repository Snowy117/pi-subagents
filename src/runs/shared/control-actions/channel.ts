import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAtomicJsonWriter } from "../../../shared/atomic-json.ts";
import {
	CONTROL_ACTION_VERSION,
	parseControlActionRequest,
	parseControlActionResponse,
	type ChildControlActionRequest,
	type ChildControlActionResponse,
} from "./actions.ts";
import { actionRequestsDir, actionResponsesDir, actionTargetDir } from "./paths.ts";

export const DEFAULT_CONTROL_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export type ControlActionChannelFs = Pick<typeof fs, "existsSync" | "mkdirSync" | "readFileSync" | "readdirSync" | "renameSync" | "rmSync" | "statSync" | "writeFileSync">;
export interface ControlActionChannelDeps {
	fs?: ControlActionChannelFs;
	now?: () => number;
	id?: () => string;
	random?: () => number;
	pid?: number;
	wait?: (delayMs: number) => void;
}

function safeSegment(value: string): string {
	return Buffer.from(value).toString("base64url");
}

function requestFileName(request: ChildControlActionRequest): string {
	return `${String(request.ts).padStart(13, "0")}-${safeSegment(request.id)}.json`;
}

function responseFileName(requestId: string): string {
	return `${safeSegment(requestId)}.json`;
}

function writer(deps: ControlActionChannelDeps): ReturnType<typeof createAtomicJsonWriter> {
	return createAtomicJsonWriter({ fs: deps.fs, now: deps.now, random: deps.random, pid: deps.pid, wait: deps.wait });
}

export function writeControlActionRequest(targetDir: string, request: ChildControlActionRequest, deps: ControlActionChannelDeps = {}): string {
	const parsed = parseControlActionRequest(request);
	if (!parsed) throw new Error("Invalid control action request.");
	const filePath = path.join(actionRequestsDir(targetDir), requestFileName(parsed));
	writer(deps)(filePath, parsed);
	return filePath;
}

export function requestControlAction(
	targetDir: string,
	action: string,
	input: { payload?: unknown; source?: string } = {},
	deps: ControlActionChannelDeps = {},
): ChildControlActionRequest {
	const request: ChildControlActionRequest = {
		version: CONTROL_ACTION_VERSION,
		type: "action",
		id: deps.id?.() ?? randomUUID(),
		ts: deps.now?.() ?? Date.now(),
		action,
		...(Object.hasOwn(input, "payload") ? { payload: input.payload } : {}),
		...(input.source ? { source: input.source } : {}),
	};
	writeControlActionRequest(targetDir, request, deps);
	return request;
}

export function requestRunChildControlAction(
	runDir: string,
	index: number,
	action: string,
	input: { payload?: unknown; source?: string } = {},
	deps: ControlActionChannelDeps = {},
): ChildControlActionRequest {
	return requestControlAction(actionTargetDir(path.join(runDir, "control"), index), action, input, deps);
}

export function writeControlActionResponse(targetDir: string, response: ChildControlActionResponse, deps: ControlActionChannelDeps = {}): string {
	const parsed = parseControlActionResponse(response);
	if (!parsed) throw new Error("Invalid control action response.");
	const filePath = path.join(actionResponsesDir(targetDir), responseFileName(parsed.requestId));
	writer(deps)(filePath, parsed);
	return filePath;
}

function readJson(fsImpl: ControlActionChannelFs, filePath: string): unknown {
	return JSON.parse(fsImpl.readFileSync(filePath, "utf-8"));
}

function listEntries(fsImpl: ControlActionChannelFs, dir: string): string[] {
	try {
		return fsImpl.readdirSync(dir);
	} catch {
		// A concurrently removed or temporarily unavailable inbox is equivalent to an empty poll.
		return [];
	}
}

/** Atomically removes requests from the public inbox before returning them. */
export function claimControlActionRequests(targetDir: string, deps: ControlActionChannelDeps = {}): ChildControlActionRequest[] {
	const fsImpl = deps.fs ?? fs;
	const requestsDir = actionRequestsDir(targetDir);
	if (!fsImpl.existsSync(requestsDir)) return [];
	const claimed: ChildControlActionRequest[] = [];
	for (const entry of listEntries(fsImpl, requestsDir).filter((name) => name.endsWith(".json")).sort()) {
		const sourcePath = path.join(requestsDir, entry);
		const claimPath = path.join(requestsDir, `.${entry}.${deps.pid ?? process.pid}.claimed`);
		try {
			fsImpl.renameSync(sourcePath, claimPath);
		} catch {
			// Another consumer won the atomic rename or the file disappeared.
			continue;
		}
		try {
			const request = parseControlActionRequest(readJson(fsImpl, claimPath));
			if (!request) continue;
			const responsePath = path.join(actionResponsesDir(targetDir), responseFileName(request.id));
			if (!fsImpl.existsSync(responsePath)) claimed.push(request);
		} catch {
			// Malformed files are quarantined by the claim and discarded below.
		} finally {
			try {
				fsImpl.rmSync(claimPath, { force: true });
			} catch {
				// The request is already claimed; a stale hidden file is harmless and TTL cleanup handles it.
			}
		}
	}
	return claimed.sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id));
}

export function consumeControlActionResponses(targetDir: string, deps: ControlActionChannelDeps = {}): ChildControlActionResponse[] {
	const fsImpl = deps.fs ?? fs;
	const responsesDir = actionResponsesDir(targetDir);
	if (!fsImpl.existsSync(responsesDir)) return [];
	const responses: ChildControlActionResponse[] = [];
	for (const entry of listEntries(fsImpl, responsesDir).filter((name) => name.endsWith(".json")).sort()) {
		const sourcePath = path.join(responsesDir, entry);
		const claimPath = path.join(responsesDir, `.${entry}.${deps.pid ?? process.pid}.claimed`);
		try {
			fsImpl.renameSync(sourcePath, claimPath);
		} catch {
			// Another consumer won the atomic rename or the response disappeared.
			continue;
		}
		try {
			const response = parseControlActionResponse(readJson(fsImpl, claimPath));
			if (response) responses.push(response);
		} catch {
			// Malformed responses are quarantined by the claim and discarded below.
		} finally {
			try {
				fsImpl.rmSync(claimPath, { force: true });
			} catch {
				// The response is already claimed; TTL cleanup can remove a stale hidden file.
			}
		}
	}
	return responses.sort((left, right) => left.ts - right.ts || left.requestId.localeCompare(right.requestId));
}

export function consumeControlActionResponse(
	targetDir: string,
	requestId: string,
	deps: ControlActionChannelDeps = {},
): ChildControlActionResponse | undefined {
	if (!requestId.trim()) return undefined;
	const fsImpl = deps.fs ?? fs;
	const sourcePath = path.join(actionResponsesDir(targetDir), responseFileName(requestId));
	if (!fsImpl.existsSync(sourcePath)) return undefined;
	const claimPath = `${sourcePath}.${deps.pid ?? process.pid}.claimed`;
	try {
		fsImpl.renameSync(sourcePath, claimPath);
	} catch {
		return undefined;
	}
	try {
		const response = parseControlActionResponse(readJson(fsImpl, claimPath));
		return response?.requestId === requestId ? response : undefined;
	} catch {
		return undefined;
	} finally {
		try {
			fsImpl.rmSync(claimPath, { force: true });
		} catch {
			// A claimed response is no longer visible; TTL cleanup can remove the stale claim.
		}
	}
}

export function cleanupControlActionFiles(
	targetDir: string,
	options: { ttlMs?: number } = {},
	deps: ControlActionChannelDeps = {},
): number {
	const fsImpl = deps.fs ?? fs;
	const cutoff = (deps.now?.() ?? Date.now()) - (options.ttlMs ?? DEFAULT_CONTROL_ACTION_TTL_MS);
	let removed = 0;
	for (const dir of [actionRequestsDir(targetDir), actionResponsesDir(targetDir)]) {
		if (!fsImpl.existsSync(dir)) continue;
		for (const entry of listEntries(fsImpl, dir)) {
			const filePath = path.join(dir, entry);
			try {
				if (fsImpl.statSync(filePath).mtimeMs >= cutoff) continue;
				fsImpl.rmSync(filePath, { force: true, recursive: true });
				removed++;
			} catch {
				// Cleanup is opportunistic; active consumers may move files concurrently.
			}
		}
	}
	return removed;
}
