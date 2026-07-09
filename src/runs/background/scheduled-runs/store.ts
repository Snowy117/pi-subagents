import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../../shared/atomic-json.ts";
import { SCHEDULED_RUNS_DIR, type ScheduledRunJob, type ScheduledRunState, type ScheduledRunStoreData } from "./types.ts";

export function scheduledRunStorePath(cwd: string, sessionId: string, root = SCHEDULED_RUNS_DIR): string {
	const digest = createHash("sha256").update(`${path.resolve(cwd)}\0${sessionId}`).digest("hex").slice(0, 20);
	return path.join(root, `${digest}.json`);
}

function readStoreData(filePath: string, cwd: string, sessionId: string): ScheduledRunStoreData {
	if (!fs.existsSync(filePath)) return { version: 1, cwd, sessionId, jobs: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse scheduled subagent store '${filePath}': ${message}`, { cause: error instanceof Error ? error : undefined });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Scheduled subagent store '${filePath}' must be a JSON object.`);
	}
	const data = parsed as Partial<ScheduledRunStoreData>;
	if (data.version !== 1) throw new Error(`Unsupported scheduled subagent store version in '${filePath}'.`);
	if (!Array.isArray(data.jobs)) throw new Error(`Scheduled subagent store '${filePath}' must contain a jobs array.`);
	const jobs: ScheduledRunJob[] = [];
	const validStates = new Set<ScheduledRunState>(["scheduled", "running", "fired", "canceled", "missed", "failed"]);
	for (const [index, job] of data.jobs.entries()) {
		if (!job || typeof job !== "object" || Array.isArray(job)) throw new Error(`Scheduled subagent store '${filePath}' job ${index} must be an object.`);
		const candidate = job as Partial<ScheduledRunJob>;
		if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || typeof candidate.schedule !== "string" || typeof candidate.cwd !== "string" || typeof candidate.sessionId !== "string") {
			throw new Error(`Scheduled subagent store '${filePath}' job ${index} has invalid string fields.`);
		}
		const timestamps = [candidate.runAt, candidate.createdAt, candidate.updatedAt];
		if (timestamps.some((value) => typeof value !== "number" || !Number.isFinite(value) || Number.isNaN(new Date(value).getTime()))) {
			throw new Error(`Scheduled subagent store '${filePath}' job ${index} has invalid timestamps.`);
		}
		if (!candidate.state || !validStates.has(candidate.state)) throw new Error(`Scheduled subagent store '${filePath}' job ${index} has invalid state.`);
		if (!candidate.params || typeof candidate.params !== "object" || Array.isArray(candidate.params)) throw new Error(`Scheduled subagent store '${filePath}' job ${index} has invalid params.`);
		jobs.push(candidate as ScheduledRunJob);
	}
	return {
		version: 1,
		cwd: typeof data.cwd === "string" ? data.cwd : cwd,
		sessionId: typeof data.sessionId === "string" ? data.sessionId : sessionId,
		jobs,
	};
}

export class ScheduledRunStore {
	private readonly filePath: string;
	private readonly cwd: string;
	private readonly sessionId: string;

	constructor(filePath: string, cwd: string, sessionId: string) {
		this.filePath = filePath;
		this.cwd = cwd;
		this.sessionId = sessionId;
	}

	list(): ScheduledRunJob[] {
		return readStoreData(this.filePath, this.cwd, this.sessionId).jobs;
	}

	get(id: string): ScheduledRunJob | undefined {
		return this.list().find((job) => job.id === id);
	}

	mutate<T>(fn: (data: ScheduledRunStoreData) => T): T {
		const data = readStoreData(this.filePath, this.cwd, this.sessionId);
		const result = fn(data);
		writeAtomicJson(this.filePath, data);
		return result;
	}
}
