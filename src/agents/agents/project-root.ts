/**
 * Project-root and directory-existence filesystem primitives.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectConfigDir } from "../../shared/utils.ts";

export function findNearestProjectRoot(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		if (isDirectory(getProjectConfigDir(currentDir)) || isDirectory(path.join(currentDir, ".agents"))) {
			return currentDir;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}
