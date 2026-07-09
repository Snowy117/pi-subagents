/**
 * Chain run directory management: create, remove, and best-effort cleanup
 * of stale chain directories under the scoped temp root.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CHAIN_RUNS_DIR } from "../types.ts";

const CHAIN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function createChainDir(runId: string, baseDir?: string): string {
	const chainDir = path.join(baseDir ? path.resolve(baseDir) : CHAIN_RUNS_DIR, runId);
	fs.mkdirSync(chainDir, { recursive: true });
	return chainDir;
}

export function removeChainDir(chainDir: string): void {
	try {
		fs.rmSync(chainDir, { recursive: true });
	} catch {
		// Chain cleanup is best-effort. Runs can already have cleaned their temp dir.
	}
}

export function cleanupOldChainDirs(): void {
	if (!fs.existsSync(CHAIN_RUNS_DIR)) return;
	const now = Date.now();
	let dirs: string[];
	try {
		dirs = fs.readdirSync(CHAIN_RUNS_DIR);
	} catch {
		// Startup cleanup is best-effort. If the scoped temp root is unreadable,
		// skip cleanup instead of failing extension startup.
		return;
	}

	for (const dir of dirs) {
		try {
			const dirPath = path.join(CHAIN_RUNS_DIR, dir);
			const stat = fs.statSync(dirPath);
			if (stat.isDirectory() && now - stat.mtimeMs > CHAIN_DIR_MAX_AGE_MS) {
				fs.rmSync(dirPath, { recursive: true });
			}
		} catch {
			// Skip directories that can't be processed; continue with others
		}
	}
}
