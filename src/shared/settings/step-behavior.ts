/**
 * Chain step behavior resolution: per-step output/reads/progress/skills
 * resolution, read-only-task policy detection, and parallel-task behavior
 * resolution with namespaced output paths.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../../agents/agents.ts";
import { normalizeSkillInput } from "../../agents/skills.ts";
import type { ResolvedStepBehavior, StepOverrides, ParallelTaskItem } from "./chain-types.ts";

function normalizeOutputOverride(output: string | false | undefined): string | false | undefined {
	return output === "false" ? false : output;
}

/**
 * Resolve effective chain behavior per step.
 * Priority: step override > agent frontmatter > false (disabled)
 */
export function resolveStepBehavior(
	agentConfig: AgentConfig,
	stepOverrides: StepOverrides,
	chainSkills?: string[],
): ResolvedStepBehavior {
	// Output: step override > frontmatter > false (no output)
	const stepOutput = normalizeOutputOverride(stepOverrides.output);
	const output =
		stepOutput !== undefined
			? stepOutput
			: normalizeOutputOverride(agentConfig.output) ?? false;

	// Reads: step override > frontmatter defaultReads > false (no reads)
	const reads =
		stepOverrides.reads !== undefined
			? stepOverrides.reads
			: agentConfig.defaultReads ?? false;

	// Progress: step override > frontmatter defaultProgress > false
	const progress =
		stepOverrides.progress !== undefined
			? stepOverrides.progress
			: agentConfig.defaultProgress ?? false;

	let skills: string[] | false;
	if (stepOverrides.skills === false) {
		skills = false;
	} else if (stepOverrides.skills !== undefined) {
		skills = [...stepOverrides.skills];
		if (chainSkills && chainSkills.length > 0) {
			skills = [...new Set([...skills, ...chainSkills])];
		}
	} else {
		skills = agentConfig.skills ? [...agentConfig.skills] : [];
		if (chainSkills && chainSkills.length > 0) {
			skills = [...new Set([...skills, ...chainSkills])];
		}
	}

	const outputMode = stepOverrides.outputMode ?? "inline";
	const model = stepOverrides.model ?? agentConfig.model;
	return { output, outputMode, reads, progress, skills, model };
}

export function resolveTaskTextForFileUpdatePolicy(task: string | undefined, originalTask?: string): string | undefined {
	if (!task) return originalTask;
	return originalTask ? task.replaceAll("{task}", originalTask) : task;
}

export function taskDisallowsFileUpdates(task: string | undefined): boolean {
	if (!task) return false;
	return /\breview[- ]only\b/i.test(task)
		|| /\bread[- ]only\s+(?:review|audit|inspection|pass)\b/i.test(task)
		|| /\b(?:no|without)\s+(?:file\s+)?edits?\b/i.test(task)
		|| /\b(?:do not|don't|must not)\s+(?:edit|modify|write|touch)\b/i.test(task)
		|| /\bleave\s+files?\s+unchanged\b/i.test(task);
}

export function suppressProgressForReadOnlyTask(behavior: ResolvedStepBehavior, task: string | undefined, originalTask?: string): ResolvedStepBehavior {
	const policyTask = resolveTaskTextForFileUpdatePolicy(task, originalTask);
	return behavior.progress && taskDisallowsFileUpdates(policyTask) ? { ...behavior, progress: false } : behavior;
}

/**
 * Resolve behaviors for all tasks in a parallel step.
 * Creates namespaced output paths to avoid collisions.
 */
export function resolveParallelBehaviors(
	tasks: ParallelTaskItem[],
	agentConfigs: AgentConfig[],
	stepIndex: number,
	chainSkills?: string[],
): ResolvedStepBehavior[] {
	return tasks.map((task, taskIndex) => {
		const config = agentConfigs.find((a) => a.name === task.agent);
		if (!config) {
			throw new Error(`Unknown agent: ${task.agent}`);
		}

		// Build subdirectory path for this parallel task
		const subdir = path.join(`parallel-${stepIndex}`, `${taskIndex}-${task.agent}`);

		// Output: task override > agent default (namespaced) > false
		// Absolute paths pass through unchanged; relative paths get namespaced under subdir
		let output: string | false = false;
		const taskOutput = normalizeOutputOverride(task.output);
		const configOutput = normalizeOutputOverride(config.output);
		if (taskOutput !== undefined) {
			if (taskOutput === false) {
				output = false;
			} else if (path.isAbsolute(taskOutput)) {
				output = taskOutput; // Absolute path: use as-is
			} else {
				output = path.join(subdir, taskOutput); // Relative: namespace under subdir
			}
		} else if (configOutput) {
			// Agent defaults are always relative, so namespace them
			output = path.join(subdir, configOutput);
		}

		// Reads: task override > agent default > false
		const reads =
			task.reads !== undefined ? task.reads : config.defaultReads ?? false;

		// Progress: task override > agent default > false
		const progress =
			task.progress !== undefined
				? task.progress
				: config.defaultProgress ?? false;

		const taskSkillInput = normalizeSkillInput(task.skill);
		let skills: string[] | false;
		if (taskSkillInput === false) {
			skills = false;
		} else if (taskSkillInput !== undefined) {
			skills = [...taskSkillInput];
			if (chainSkills && chainSkills.length > 0) {
				skills = [...new Set([...skills, ...chainSkills])];
			}
		} else {
			skills = config.skills ? [...config.skills] : [];
			if (chainSkills && chainSkills.length > 0) {
				skills = [...new Set([...skills, ...chainSkills])];
			}
		}

		const outputMode = task.outputMode ?? "inline";
		const model = task.model ?? config.model;
		return { output, outputMode, reads, progress, skills, model };
	});
}

/**
 * Create subdirectories for parallel step outputs
 */
export function createParallelDirs(
	chainDir: string,
	stepIndex: number,
	taskCount: number,
	agentNames: string[],
): void {
	for (let i = 0; i < taskCount; i++) {
		const subdir = path.join(chainDir, `parallel-${stepIndex}`, `${i}-${agentNames[i]}`);
		fs.mkdirSync(subdir, { recursive: true });
	}
}
