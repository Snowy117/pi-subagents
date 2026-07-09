import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CreateWorktreesOptions, ResolvedWorktreeSetupHook, WorktreeInfo, WorktreeSetup } from "./types.ts";
import { resolveRepoCwdRelative, resolveRepoState, runGit, runGitChecked } from "./git.ts";
import { resolveWorktreeSetupHook, runWorktreeSetupHook } from "./setup-hook.ts";

export function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number, baseDir?: string): string {
	const cwdRelative = resolveRepoCwdRelative(cwd);
	const repoRoot = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
	const worktreePath = buildWorktreePath(resolveWorktreeBaseDir(baseDir, repoRoot), runId, index);
	return cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
}

export function createWorktrees(cwd: string, runId: string, count: number, options?: CreateWorktreesOptions): WorktreeSetup {
	const repo = resolveRepoState(cwd);
	const setupHook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook);
	const baseDir = resolveWorktreeBaseDir(options?.baseDir, repo.toplevel);
	const worktrees: WorktreeInfo[] = [];

	try {
		for (let index = 0; index < count; index++) {
			worktrees.push(createSingleWorktree(
				repo.toplevel,
				repo.cwdRelative,
				runId,
				index,
				repo.baseCommit,
				setupHook,
				options?.agents?.[index],
				baseDir,
			));
		}
	} catch (error) {
		cleanupWorktrees({
			cwd: repo.toplevel,
			worktrees,
			baseCommit: repo.baseCommit,
		});
		throw error;
	}

	return {
		cwd: repo.toplevel,
		worktrees,
		baseCommit: repo.baseCommit,
	};
}

export function cleanupWorktrees(setup: WorktreeSetup): void {
	for (let index = setup.worktrees.length - 1; index >= 0; index--) {
		cleanupSingleWorktree(setup.cwd, setup.worktrees[index]!);
	}
	try { runGitChecked(setup.cwd, ["worktree", "prune"]); } catch {
		// Pruning is best-effort cleanup.
	}
}

function buildWorktreeBranch(runId: string, index: number): string {
	return `pi-parallel-${runId}-${index}`;
}

function resolveWorktreeBaseDir(configuredBaseDir: string | undefined, repoRoot: string): string {
	const rawBaseDir = configuredBaseDir ?? process.env.PI_SUBAGENTS_WORKTREE_DIR;
	if (rawBaseDir === undefined) return os.tmpdir();

	const trimmed = rawBaseDir.trim();
	if (!trimmed) throw new Error("worktree base directory cannot be empty");

	const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
	try {
		fs.mkdirSync(resolved, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to create worktree base directory ${resolved}: ${message}`);
	}
	return resolved;
}

function buildWorktreePath(baseDir: string, runId: string, index: number): string {
	return path.join(baseDir, `pi-worktree-${runId}-${index}`);
}

function linkNodeModulesIfPresent(toplevel: string, worktreePath: string): boolean {
	const nodeModulesPath = path.join(toplevel, "node_modules");
	const nodeModulesLinkPath = path.join(worktreePath, "node_modules");
	if (!fs.existsSync(nodeModulesPath) || fs.existsSync(nodeModulesLinkPath)) return false;
	try {
		fs.symlinkSync(nodeModulesPath, nodeModulesLinkPath);
		return true;
	} catch {
		// Symlink creation is optional (e.g., unsupported filesystems on CI runners).
		return false;
	}
}

function createSingleWorktree(
	toplevel: string,
	cwdRelative: string,
	runId: string,
	index: number,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
	baseDir: string,
): WorktreeInfo {
	const branch = buildWorktreeBranch(runId, index);
	const worktreePath = buildWorktreePath(baseDir, runId, index);
	const add = runGit(toplevel, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
	if (add.status !== 0) {
		const message = add.stderr.trim() || add.stdout.trim() || `failed to create worktree ${worktreePath}`;
		throw new Error(message);
	}

	const agentCwd = cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
	try {
		const nodeModulesLinked = linkNodeModulesIfPresent(toplevel, worktreePath);
		const syntheticPaths = nodeModulesLinked ? ["node_modules"] : [];

		if (setupHook) {
			const hookSyntheticPaths = runWorktreeSetupHook(setupHook, {
				version: 1,
				repoRoot: toplevel,
				worktreePath,
				agentCwd,
				branch,
				index,
				runId,
				baseCommit,
				agent,
			});
			syntheticPaths.push(...hookSyntheticPaths);
		}

		return {
			path: worktreePath,
			agentCwd,
			branch,
			index,
			nodeModulesLinked,
			syntheticPaths,
		};
	} catch (error) {
		try { runGitChecked(toplevel, ["worktree", "remove", "--force", worktreePath]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		try { runGitChecked(toplevel, ["branch", "-D", branch]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		throw error;
	}
}

function cleanupSingleWorktree(repoCwd: string, worktree: WorktreeInfo): void {
	try { runGitChecked(repoCwd, ["worktree", "remove", "--force", worktree.path]); } catch {
		// Cleanup is best-effort to avoid masking caller errors.
	}
	try { runGitChecked(repoCwd, ["branch", "-D", worktree.branch]); } catch {
		// Cleanup is best-effort to avoid masking caller errors.
	}
}
