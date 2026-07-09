/**
 * Filesystem skill collection: walk skill directories, infer sources, dedupe.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getProjectConfigDir } from "../../shared/utils.ts";
import { getGlobalNpmRoot } from "./package-discovery.ts";
import { SOURCE_PRIORITY, type CachedSkillEntry, type SkillSearchPath, type SkillSource } from "./types.ts";

export function isWithinPath(filePath: string, dir: string): boolean {
	const relative = path.relative(dir, filePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function inferSkillSource(filePath: string, cwd: string, agentDir: string, sourceHint?: SkillSource): SkillSource {
	if (sourceHint) return sourceHint;

	const projectConfigRoot = path.resolve(getProjectConfigDir(cwd));
	const projectSkillsRoot = path.resolve(projectConfigRoot, "skills");
	const projectPackagesRoot = path.resolve(projectConfigRoot, "npm", "node_modules");
	const projectAgentsRoot = path.resolve(cwd, ".agents");
	const userSkillsRoot = path.resolve(agentDir, "skills");
	const userPackagesRoot = path.resolve(agentDir, "npm", "node_modules");
	const userAgentRoot = path.resolve(agentDir);
	const userAgentsRoot = path.resolve(os.homedir(), ".agents");

	if (isWithinPath(filePath, projectPackagesRoot)) return "project-package";
	if (isWithinPath(filePath, projectSkillsRoot) || isWithinPath(filePath, projectAgentsRoot)) return "project";
	if (isWithinPath(filePath, projectConfigRoot)) return "project-settings";

	if (isWithinPath(filePath, userPackagesRoot)) return "user-package";
	if (isWithinPath(filePath, userSkillsRoot) || isWithinPath(filePath, userAgentsRoot)) return "user";
	if (isWithinPath(filePath, userAgentRoot)) return "user-settings";

	const globalRoot = getGlobalNpmRoot();
	if (globalRoot && isWithinPath(filePath, globalRoot)) return "user-package";

	return "unknown";
}

export function chooseHigherPrioritySkill(existing: CachedSkillEntry | undefined, candidate: CachedSkillEntry): CachedSkillEntry {
	if (!existing) return candidate;
	const existingPriority = SOURCE_PRIORITY[existing.source] ?? 0;
	const candidatePriority = SOURCE_PRIORITY[candidate.source] ?? 0;
	if (candidatePriority > existingPriority) return candidate;
	if (candidatePriority < existingPriority) return existing;
	return candidate.order < existing.order ? candidate : existing;
}

export function maybeReadSkillDescription(filePath: string): string | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const normalized = content.replace(/\r\n/g, "\n");
		if (!normalized.startsWith("---")) return undefined;

		const endIndex = normalized.indexOf("\n---", 3);
		if (endIndex === -1) return undefined;

		const frontmatter = normalized.slice(3, endIndex).trim();
		const match = frontmatter.match(/^description:\s*(.+)$/m);
		if (!match) return undefined;
		return match[1]?.trim().replace(/^['\"]|['\"]$/g, "");
	} catch {
		// Description parsing is best-effort metadata extraction.
		return undefined;
	}
}

export function collectFilesystemSkills(cwd: string, agentDir: string, skillPaths: SkillSearchPath[]): CachedSkillEntry[] {
	const entries: CachedSkillEntry[] = [];
	const seen = new Map<string, number>();
	const visitedDirectories = new Map<string, number>();
	let order = 0;

	const pushEntry = (name: string, filePath: string, sourceHint?: SkillSource) => {
		const resolvedFile = path.resolve(filePath);
		if (!fs.existsSync(resolvedFile)) return;
		const source = inferSkillSource(resolvedFile, cwd, agentDir, sourceHint);
		const existingIndex = seen.get(resolvedFile);
		if (existingIndex !== undefined) {
			const existing = entries[existingIndex];
			if (existing && (SOURCE_PRIORITY[source] ?? 0) > (SOURCE_PRIORITY[existing.source] ?? 0)) {
				entries[existingIndex] = {
					...existing,
					name,
					source,
					description: maybeReadSkillDescription(resolvedFile),
				};
			}
			return;
		}
		seen.set(resolvedFile, entries.length);
		entries.push({
			name,
			filePath: resolvedFile,
			source,
			description: maybeReadSkillDescription(resolvedFile),
			order: order++,
		});
	};

	const shouldSkipDirectory = (name: string) => name.startsWith(".") || name === "node_modules";

	const markDirectoryVisited = (dirPath: string, sourceHint?: SkillSource): boolean => {
		let resolvedDir: string;
		try {
			resolvedDir = fs.realpathSync(dirPath);
		} catch {
			resolvedDir = path.resolve(dirPath);
		}
		const priority = sourceHint ? SOURCE_PRIORITY[sourceHint] ?? 0 : SOURCE_PRIORITY.unknown;
		const previousPriority = visitedDirectories.get(resolvedDir);
		if (previousPriority !== undefined && previousPriority >= priority) return false;
		visitedDirectories.set(resolvedDir, priority);
		return true;
	};

	const walkSkillDirectories = (dirPath: string, sourceHint?: SkillSource) => {
		if (!markDirectoryVisited(dirPath, sourceHint)) return;

		const skillFile = path.join(dirPath, "SKILL.md");
		if (fs.existsSync(skillFile)) {
			pushEntry(path.basename(dirPath), skillFile, sourceHint);
			return;
		}

		let entriesInDir: fs.Dirent[];
		try {
			entriesInDir = fs.readdirSync(dirPath, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entriesInDir) {
			if (shouldSkipDirectory(entry.name)) continue;
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

			const entryPath = path.join(dirPath, entry.name);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(entryPath);
			} catch {
				continue;
			}
			if (stat.isDirectory()) {
				walkSkillDirectories(entryPath, sourceHint);
			}
		}
	};

	for (const skillPath of skillPaths) {
		if (!fs.existsSync(skillPath.path)) continue;

		let stat: fs.Stats;
		try {
			stat = fs.statSync(skillPath.path);
		} catch {
			continue;
		}

		if (stat.isFile()) {
			const fileName = path.basename(skillPath.path);
			if (!fileName.toLowerCase().endsWith(".md")) continue;
			const skillName = fileName.toLowerCase() === "skill.md"
				? path.basename(path.dirname(skillPath.path))
				: path.basename(fileName, path.extname(fileName));
			pushEntry(skillName, skillPath.path, skillPath.source);
			continue;
		}

		if (!stat.isDirectory()) continue;

		const rootSkillFile = path.join(skillPath.path, "SKILL.md");
		if (fs.existsSync(rootSkillFile)) {
			pushEntry(path.basename(skillPath.path), rootSkillFile, skillPath.source);
			continue;
		}

		markDirectoryVisited(skillPath.path, skillPath.source);

		let childEntries: fs.Dirent[];
		try {
			childEntries = fs.readdirSync(skillPath.path, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const child of childEntries) {
			if (child.name.startsWith(".")) continue;
			const childPath = path.join(skillPath.path, child.name);
			if (child.isDirectory() || child.isSymbolicLink()) {
				if (shouldSkipDirectory(child.name)) continue;
				let childStat: fs.Stats;
				try {
					childStat = fs.statSync(childPath);
				} catch {
					continue;
				}
				if (childStat.isDirectory()) walkSkillDirectories(childPath, skillPath.source);
				continue;
			}
			if (child.isFile() && child.name.toLowerCase().endsWith(".md")) {
				pushEntry(path.basename(child.name, path.extname(child.name)), childPath, skillPath.source);
			}
		}
	}

	return entries;
}
