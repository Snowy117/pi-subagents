import * as path from "node:path";
import { TEMP_ROOT_DIR } from "../../../shared/types.ts";

export const FOREGROUND_RUNS_DIR = path.join(TEMP_ROOT_DIR, "foreground-subagent-runs");
export const ACTION_TARGETS_DIR_NAME = "action-targets";

function assertIndex(index: number): void {
	if (!Number.isInteger(index) || index < 0) throw new Error("control action child index must be a non-negative integer.");
}

export function foregroundRunDir(runId: string): string {
	if (!runId.trim()) throw new Error("foreground run id must not be empty.");
	if (path.basename(runId) !== runId || runId === "." || runId === "..") throw new Error("foreground run id must be a safe path segment.");
	return path.join(FOREGROUND_RUNS_DIR, runId);
}

export function foregroundControlRoot(runId: string): string {
	return path.join(foregroundRunDir(runId), "control");
}

export function foregroundSteerInboxDir(runId: string, index: number): string {
	assertIndex(index);
	return path.join(foregroundControlRoot(runId), "steer-targets", String(index));
}

export function actionTargetDir(controlRoot: string, index: number): string {
	assertIndex(index);
	return path.join(controlRoot, ACTION_TARGETS_DIR_NAME, String(index));
}

export function actionRequestsDir(targetDir: string): string {
	return path.join(targetDir, "requests");
}

export function actionResponsesDir(targetDir: string): string {
	return path.join(targetDir, "responses");
}

export function childActionTargetDir(runDir: string, index: number): string {
	return actionTargetDir(path.join(runDir, "control"), index);
}
