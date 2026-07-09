/** async-resume (split from subagent-executor.ts). Internal-only. */

import { resolveExecutionAgentScope } from "../../../agents/agent-scope.ts";
import { type AgentScope } from "../../../agents/agents.ts";
import { normalizeSkillInput } from "../../../agents/skills.ts";
import { applyIntercomBridgeToAgent, resolveIntercomBridge, resolveIntercomSessionTarget, resolveSubagentIntercomTarget } from "../../../intercom/intercom-bridge.ts";
import { deliverSubagentIntercomMessageEvent } from "../../../intercom/result-intercom.ts";
import { getArtifactsDir } from "../../../shared/artifacts.ts";
import { toModelInfo } from "../../../shared/model-info.ts";
import { resolveCurrentSessionId } from "../../../shared/session-identity.ts";
import { type ChainStep } from "../../../shared/settings.ts";
import { type ArtifactConfig, type Details, ASYNC_DIR, DEFAULT_ARTIFACT_CONFIG, RESULTS_DIR, checkSubagentDepth, resolveCurrentMaxSubagentDepth } from "../../../shared/types.ts";
import { executeAsyncChain, executeAsyncSingle, formatAsyncStartedMessage, isAsyncAvailable } from "../../background/async-execution.ts";
import { buildRevivedAsyncTask, interruptLiveAsyncResumeTarget } from "../../background/async-resume.ts";
import { resolveAsyncRootResultPath } from "../../background/chain-root-attachment.ts";
import { type ResolvedSubagentRunId, resolveSubagentRunId } from "../../background/run-id-resolver.ts";
import { resolveControlConfig } from "../../shared/subagent-control.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { resolveExplicitContextPolicy } from "./budget-resolution.ts";
import { nestedResolutionScopeForExecutor } from "./foreground-state.ts";
import { wrapChainTasksForFork } from "./fork-helpers.ts";
import { resolveNestedResumeTarget, resumeLiveNestedRun } from "./nested-runs.ts";
import { resolveSingleRunOutputBaseDir } from "./parallel-helpers.ts";
import { isResumeAmbiguity, resolveResumeTarget, type ResumeSourceTarget } from "./resume-targets.ts";
import { type ExecutorDeps, type SubagentParamsLike } from "./types.ts";
import * as path from "node:path";


export async function resumeAsyncRun(input: {
	params: SubagentParamsLike;
	requestCwd: string;
	ctx: ExtensionContext;
	deps: ExecutorDeps;
}): Promise<AgentToolResult<Details>> {
	const followUp = (input.params.message ?? input.params.task ?? "").trim();
	const attachChain = (input.params.chain?.length ?? 0) > 0 ? input.params.chain as ChainStep[] : undefined;
	if (!followUp && !attachChain) {
		return {
			content: [{ type: "text", text: "action='resume' requires message." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	let target: ResumeSourceTarget;
	const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
	try {
		const requestedId = input.params.id ?? input.params.runId;
		let resolved: ResolvedSubagentRunId | undefined;
		try {
			resolved = requestedId ? resolveSubagentRunId(requestedId, { state: input.deps.state, nested: nestedResolutionScopeForExecutor(input.deps) }) : undefined;
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			const asyncMatches = message.match(/async:/g)?.length ?? 0;
			if (!isResumeAmbiguity(error) || !message.includes("foreground:") || asyncMatches !== 1) throw error;
		}
		if (resolved?.kind === "nested") {
			if (attachChain) {
				return {
					content: [{ type: "text", text: "Attaching a running subagent as a chain root is currently available for top-level async runs only." }],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			if (resolved.match.run.state === "running" || resolved.match.run.state === "queued") {
				return resumeLiveNestedRun({ target: resolved, message: followUp });
			}
			const trustedSessionRoots = [
				...(input.deps.config.defaultSessionDir ? [path.resolve(input.deps.expandTilde(input.deps.config.defaultSessionDir))] : []),
				...(parentSessionFile ? [input.deps.getSubagentSessionRoot(parentSessionFile)] : []),
			];
			target = resolveNestedResumeTarget(resolved, trustedSessionRoots);
		} else {
			target = resolveResumeTarget(input.params, input.deps.state, { asyncRequireSessionFile: !attachChain });
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
	}

	if (target.kind === "live" && !attachChain) {
		const interrupt = interruptLiveAsyncResumeTarget({
			target,
			state: input.deps.state,
			kill: input.deps.kill,
			resultsDir: RESULTS_DIR,
		});
		if (!interrupt.ok) {
			return {
				content: [{ type: "text", text: interrupt.message }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		const delivered = await deliverSubagentIntercomMessageEvent(
			input.deps.pi.events,
			target.intercomTarget,
			`Follow-up for async run ${target.runId} (${target.agent}):\n\n${followUp}`,
			500,
			{ source: "async-resume", runId: target.runId, agent: target.agent, index: target.index },
		);
		if (delivered) {
			return {
				content: [{ type: "text", text: [`Interrupted live async child, then delivered follow-up.`, `Run: ${target.runId}`, `Intercom target: ${target.intercomTarget}`].join("\n") }],
				details: { mode: "management", results: [] },
			};
		}
		return {
			content: [{ type: "text", text: [`Async child appears live but its intercom target is not registered.`, `Run: ${target.runId}`, `Intercom target: ${target.intercomTarget}`, `Wait for completion, then retry action='resume'.`].join("\n") }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const { blocked, depth, maxDepth } = checkSubagentDepth(input.deps.config.maxSubagentDepth);
	if (blocked) {
		return {
			content: [{ type: "text", text: `Nested subagent resume blocked (depth=${depth}, max=${maxDepth}). Complete the follow-up directly instead.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
	const effectiveCwd = target.cwd ?? input.requestCwd;
	const scope: AgentScope = resolveExecutionAgentScope(input.params.agentScope);
	const discovered = input.deps.discoverAgents(effectiveCwd, scope);
	const discoveredAgents = discovered.agents;
	const modelScope = discovered.modelScope;
	const sessionName = resolveIntercomSessionTarget(input.deps.pi.getSessionName(), input.ctx.sessionManager.getSessionId());
	const intercomBridge = resolveIntercomBridge({
		config: input.deps.config.intercomBridge,
		context: input.params.context,
		orchestratorTarget: sessionName,
	});
	const agents = intercomBridge.active
		? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
		: discoveredAgents;
	const agentConfig = agents.find((agent) => agent.name === target.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent for resume: ${target.agent}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	if (attachChain) {
		if (target.source !== "async") {
			return {
				content: [{ type: "text", text: "Attaching a running subagent as a chain root is currently available for async runs only." }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		if (!isAsyncAvailable()) {
			return {
				content: [{ type: "text", text: "Async mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
				isError: true,
				details: { mode: "chain", results: [] },
			};
		}
		const runId = randomUUID().slice(0, 8);
		const artifactConfig: ArtifactConfig = { ...DEFAULT_ARTIFACT_CONFIG, enabled: input.params.artifacts !== false };
		const availableModels = input.ctx.modelRegistry.getAvailable().map(toModelInfo);
		const contextPolicy = resolveExplicitContextPolicy(input.params);
		const chain = wrapChainTasksForFork(attachChain, contextPolicy);
		const normalized = normalizeSkillInput(input.params.skill);
		const result = executeAsyncChain(runId, {
			chain,
			task: (input.params.task ?? followUp) || undefined,
			attachRoot: {
				runId: target.runId,
				asyncDir: target.asyncDir ?? path.join(ASYNC_DIR, target.runId),
				resultPath: resolveAsyncRootResultPath(RESULTS_DIR, target.runId),
				index: target.index,
				agent: target.agent,
				label: `Attached ${target.runId}`,
			},
			agents,
			ctx: {
				pi: input.deps.pi,
				cwd: input.requestCwd,
				currentSessionId: input.deps.state.currentSessionId,
				parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
				currentModelProvider: input.ctx.model?.provider,
				currentModel: input.ctx.model,
				modelScope,
			},
			availableModels,
			cwd: effectiveCwd,
			maxOutput: input.params.maxOutput,
			artifactsDir: getArtifactsDir(parentSessionFile, effectiveCwd),
			artifactConfig,
			shareEnabled: input.params.share === true,
			sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
			chainSkills: normalized === false ? [] : (normalized ?? []),
			dynamicFanoutMaxItems: input.deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
			worktreeSetupHook: input.deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: input.deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: input.deps.config.worktreeBaseDir,
			controlConfig: resolveControlConfig(input.deps.config.control, input.params.control),
			controlIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,
			childIntercomTarget: intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
			globalConcurrencyLimit: input.deps.config.globalConcurrencyLimit,
		});
		if (result.isError) return result;
		const attachedId = result.details.asyncId ?? runId;
		const lines = [
			`Attached async subagent ${target.runId} as the first step of a new chain.`,
			`Chain run: ${attachedId}`,
			`Root: ${target.agent} (step ${target.index + 1})`,
			result.details.asyncDir ? `Async dir: ${result.details.asyncDir}` : undefined,
			`Status if needed: subagent({ action: "status", id: "${attachedId}" })`,
		].filter((line): line is string => Boolean(line));
		return { content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n")) }], details: result.details };
	}

	const runId = randomUUID().slice(0, 8);
	const artifactConfig: ArtifactConfig = { ...DEFAULT_ARTIFACT_CONFIG, enabled: input.params.artifacts !== false };
	const artifactsDir = getArtifactsDir(parentSessionFile, effectiveCwd);
	const availableModels = input.ctx.modelRegistry.getAvailable().map(toModelInfo);
	const result = executeAsyncSingle(runId, {
		agent: target.agent,
		task: buildRevivedAsyncTask(target, followUp),
		agentConfig,
		ctx: {
			pi: input.deps.pi,
			cwd: input.requestCwd,
			currentSessionId: input.deps.state.currentSessionId,
			parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
			currentModelProvider: input.ctx.model?.provider,
			currentModel: input.ctx.model,
			modelScope,
		},
		cwd: effectiveCwd,
		maxOutput: input.params.maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled: input.params.share === true,
		sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
		sessionFile: target.sessionFile,
		modelOverride: input.params.model ?? target.model,
		thinkingOverride: input.params.model ? undefined : target.thinking,
		outputBaseDir: resolveSingleRunOutputBaseDir(input.deps, artifactsDir, runId),
		maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
		worktreeSetupHook: input.deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: input.deps.config.worktreeSetupHookTimeoutMs,
		worktreeBaseDir: input.deps.config.worktreeBaseDir,
		controlConfig: resolveControlConfig(input.deps.config.control, input.params.control),
		controlIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,
		childIntercomTarget: intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
		availableModels,
	});
	if (result.isError) return result;

	const revivedId = result.details.asyncId ?? runId;
	const revivedTarget = intercomBridge.active ? resolveSubagentIntercomTarget(revivedId, target.agent, 0) : undefined;
	const sourceLabel = target.source;
	const lines = [
		`Revived ${sourceLabel} subagent from ${target.runId}.`,
		`Revived run: ${revivedId}`,
		`Agent: ${target.agent}`,
		`Session: ${target.sessionFile}`,
		result.details.asyncDir ? `Async dir: ${result.details.asyncDir}` : undefined,
		revivedTarget ? `Intercom target: ${revivedTarget} (if registered)` : undefined,
		`Status if needed: subagent({ action: "status", id: "${revivedId}" })`,
	].filter((line): line is string => Boolean(line));
	return { content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n")) }], details: result.details };
}
