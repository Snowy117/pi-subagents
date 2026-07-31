import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ROOT_DIR } from "./types.ts";

export const LIVE_TRANSCRIPTS_DIR = path.join(TEMP_ROOT_DIR, "live-transcripts");

type LiveTranscriptFs = Pick<typeof fs, "existsSync" | "mkdirSync" | "readdirSync" | "rmSync" | "writeFileSync">;

export interface LiveTranscriptDeps {
	fs?: LiveTranscriptFs;
	id?: () => string;
}

function safeRunId(runId: string): string {
	if (!runId.trim() || path.basename(runId) !== runId || runId === "." || runId === "..") {
		throw new Error("live transcript run id must be a safe path segment.");
	}
	return runId;
}

function assertIndex(index: number): void {
	if (!Number.isInteger(index) || index < 0) throw new Error("live transcript child index must be a non-negative integer.");
}

export function liveTranscriptPath(runId: string, index: number): string {
	assertIndex(index);
	return path.join(LIVE_TRANSCRIPTS_DIR, safeRunId(runId), `${index}.jsonl`);
}

export function resolveLiveTranscriptPath(input: {
	persistentPath?: string;
	runId: string;
	index: number;
}): string {
	return input.persistentPath ?? liveTranscriptPath(input.runId, input.index);
}

export function isRuntimeLiveTranscript(filePath: string): boolean {
	const relative = path.relative(LIVE_TRANSCRIPTS_DIR, path.resolve(filePath));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function refDir(filePath: string): string {
	return `${filePath}.refs`;
}

function terminalMarker(filePath: string): string {
	return `${filePath}.terminal`;
}

function cleanupIfReleased(filePath: string, fsImpl: LiveTranscriptFs): boolean {
	if (!isRuntimeLiveTranscript(filePath) || !fsImpl.existsSync(terminalMarker(filePath))) return false;
	let refs: string[] = [];
	try {
		refs = fsImpl.readdirSync(refDir(filePath));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			// An unreadable lease directory may still contain active view references.
			return false;
		}
	}
	if (refs.length > 0) return false;
	for (const candidate of [filePath, terminalMarker(filePath), refDir(filePath)]) {
		try {
			fsImpl.rmSync(candidate, { recursive: true, force: true });
		} catch {
			// Runtime transcript cleanup is best effort; session cleanup retries the root.
		}
	}
	return true;
}

/** Retain a scoped runtime transcript while a view is open. Persistent artifacts need no lease. */
export function retainLiveTranscript(filePath: string | undefined, deps: LiveTranscriptDeps = {}): () => void {
	if (!filePath || !isRuntimeLiveTranscript(filePath)) return () => {};
	const fsImpl = deps.fs ?? fs;
	const leasePath = path.join(refDir(filePath), deps.id?.() ?? randomUUID());
	try {
		fsImpl.mkdirSync(path.dirname(leasePath), { recursive: true });
		fsImpl.writeFileSync(leasePath, "", "utf-8");
	} catch {
		// A view can still read the transcript when its best-effort cleanup lease cannot be persisted.
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			fsImpl.rmSync(leasePath, { recursive: true, force: true });
		} catch {
			// Lease removal is best effort; session cleanup removes stale runtime roots.
		}
		cleanupIfReleased(filePath, fsImpl);
	};
}

/** Mark a child terminal and remove its temporary transcript once no view retains it. */
export function markLiveTranscriptTerminal(filePath: string | undefined, deps: LiveTranscriptDeps = {}): void {
	if (!filePath || !isRuntimeLiveTranscript(filePath)) return;
	const fsImpl = deps.fs ?? fs;
	try {
		fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
		fsImpl.writeFileSync(terminalMarker(filePath), "", "utf-8");
	} catch {
		// Terminal marking is best effort; session cleanup remains the final cleanup boundary.
		return;
	}
	cleanupIfReleased(filePath, fsImpl);
}

export function cleanupLiveTranscripts(deps: Pick<LiveTranscriptDeps, "fs"> = {}): void {
	try {
		(deps.fs ?? fs).rmSync(LIVE_TRANSCRIPTS_DIR, { recursive: true, force: true });
	} catch {
		// Session/reload cleanup must continue when a stale runtime transcript root is locked.
	}
}
