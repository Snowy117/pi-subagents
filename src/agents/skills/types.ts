/**
 * Skill resolution type definitions and priority constants.
 *
 * SkillSource is the only public export; the internal types/consts are
 * exported for sibling modules within the skills/ barrel tree.
 */

export type SkillSource =
	| "project"
	| "user"
	| "project-package"
	| "user-package"
	| "project-settings"
	| "user-settings"
	| "extension"
	| "builtin"
	| "unknown";

export interface ResolvedSkill {
	name: string;
	path: string;
	content: string;
	description?: string;
	source: SkillSource;
}

export interface SkillCacheEntry {
	mtime: number;
	skill: ResolvedSkill;
}

export interface CachedSkillEntry {
	name: string;
	filePath: string;
	source: SkillSource;
	description?: string;
	order: number;
}

export interface SkillSearchPath {
	path: string;
	source: SkillSource;
}

export const SUBAGENT_ORCHESTRATION_SKILL = "pi-subagents";

export const SOURCE_PRIORITY: Record<SkillSource, number> = {
	project: 700,
	"project-settings": 650,
	"project-package": 600,
	user: 300,
	"user-settings": 250,
	"user-package": 200,
	extension: 150,
	builtin: 100,
	unknown: 0,
};
