/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Modes: single (agent + task), parallel (tasks[]), chain (chain[] with {previous})
 * Toggle: async parameter (default: false, configurable via config.json)
 *
 * Config file: ~/.pi/agent/extensions/subagent/config.json
 *   { "asyncByDefault": true, "forceTopLevelAsync": true, "maxSubagentDepth": 1, "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" }, "worktreeSetupHook": "./scripts/setup-worktree.mjs" }
 */
import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents/agents.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "../shared/artifacts.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { cleanupOldChainDirs } from "../shared/settings.ts";
import { renderWidget } from "../tui/render.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { createRpcChildRegistry } from "../runs/persistent/rpc-child-registry.ts";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.ts";
import { createResultWatcher } from "../runs/background/result-watcher.ts";
import { createScheduledRunManager } from "../runs/background/scheduled-runs.ts";
import { createNativeSupervisorChannel } from "../intercom/native-supervisor-channel.ts";
import { registerSlashCommands } from "../slash/slash-commands.ts";
import { clearSlashSnapshots, restoreSlashFinalSnapshots } from "../slash/slash-live-state.ts";
import { resolveWaitToolConfig } from "../runs/background/wait.ts";
import registerSubagentNotify from "../runs/background/notify.ts";
import { PROMPT_RUNTIME_EXTENSION_PATH, SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } from "../runs/shared/pi-args.ts";
import { loadConfig, resolvePersistentChildConfig } from "./config.ts";
import {
	clearPendingForegroundControlNotices,
	handleSubagentControlNotice,
	type SubagentControlMessageDetails,
} from "./control-notices.ts";
import {
	type Details,
	type SubagentState,
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	RESULTS_DIR,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
	WIDGET_KEY,
} from "../shared/types.ts";
import { registerMessageRenderers } from "./registration/message-renderers.ts";
import { registerSubagentTools } from "./registration/tools.ts";
import { createSubagentBridges } from "./registration/bridges.ts";
import { ensureAccessibleDir, expandTilde, getSubagentSessionRoot, isStaleExtensionContextError } from "./registration/session-paths.ts";
import { createSteerViewRuntime } from "../tui/steer-view/registration.ts";
import { createHostEditorConversation } from "../tui/steer-view/host-editor-mode.ts";
import { createReopenBridge } from "../tui/steer-view/reopen-bridge.ts";

export { loadConfig } from "./config.ts";
export default function registerSubagentExtension(pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_CHILD_ENV] === "1") {
		return;
	}
	const globalStore = globalThis as Record<string, unknown>;
	const runtimeCleanupStoreKey = "__piSubagentRuntimeCleanup";
	const previousRuntimeCleanup = globalStore[runtimeCleanupStoreKey];
	if (typeof previousRuntimeCleanup === "function") {
		try {
			previousRuntimeCleanup();
		} catch {
			// Best effort cleanup for stale timers from an older reload.
		}
	}

	ensureAccessibleDir(RESULTS_DIR);
	ensureAccessibleDir(ASYNC_DIR);
	cleanupOldChainDirs();

	const config = loadConfig();
	// Product default: persistent RPC children are enabled unless the user
	// explicitly disables them. Tests that build an executor from a bare
	// `config: {}` keep the legacy json path because the field is absent there.
	// The E2E harness sets PI_SUBAGENT_E2E_JSON_CHILD to exercise the json path.
	if (config.persistentChildren === undefined && process.env.PI_SUBAGENT_E2E_JSON_CHILD !== "1") {
		config.persistentChildren = { enabled: true };
	}
	const waitToolConfig = resolveWaitToolConfig(config.waitTool);
	const asyncByDefault = config.asyncByDefault === true;
	const tempArtifactsDir = getArtifactsDir(null);
	cleanupAllArtifactDirs(DEFAULT_ARTIFACT_CONFIG.cleanupDays);

	const state: SubagentState = {
		baseCwd: "",
		currentSessionId: null,
		subagentInProgress: false,
		subagentSpawns: { sessionId: null, count: 0 },
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundLiveChildren: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
	const persistentChildRegistry = createRpcChildRegistry();
	const reopenBridge = createReopenBridge({
		registry: persistentChildRegistry,
		cwd: state.baseCwd || process.cwd(),
		getChildLaunchArgs: (target) => {
			// Rebuild a minimal RPC child for the persisted session. The
			// subagent-prompt-runtime extension is loaded so steer/control and
			// child runtime features work; original per-child flags (tools,
			// skills, extra extensions) are not retained post-eviction, so
			// child commands like DCP are only available if the child's own
			// configuration loads them.
			if (!target.sessionFile) return undefined;
			return ["--mode", "rpc", "--session", target.sessionFile, "--extension", PROMPT_RUNTIME_EXTENSION_PATH];
		},
	});
	const getResidentChild = (target: import("./tui/steer-view/target-model.ts").SteerViewTarget) => {
		// target.key is "kind:runId:index"; the foreground registry is keyed
		// "runId/index". Async children live in the runner process and are
		// resolved via a cross-process bridge (Phase 5), not here.
		const [kind, runId, indexText] = target.key.split(":");
		if (kind !== "foreground" || !runId || !indexText) return undefined;
		const key = `${runId}/${indexText}`;
		const existing = persistentChildRegistry.get(key);
		if (existing) {
			// A resident entry whose process has already exited is dead: drop it so
			// a stale handle is never handed to the viewer and reopen can take over
			// (belt-and-suspenders for entries left by older runs/crashes).
			if (existing.proc.exitCode !== null) {
				persistentChildRegistry.unregister(key);
				return reopenBridge.reopen(target);
			}
			return existing;
		}
		// Reopen an evicted settled child's session when it has a persisted
		// session file; the registry guard prevents concurrent writers.
		return reopenBridge.reopen(target);
	};
	const hostEditorConversation = createHostEditorConversation({
		getResidentChild,
	});

	// Option B eviction loop: settle idle resident children and enforce the
	// resident cap. Runs every minute; config changes take effect on next tick.
	const evictionTimer = setInterval(() => {
		// Re-read config each tick so idle/cap changes take effect without a
		// parent restart (config file is reloaded by loadConfig below).
		const current = resolvePersistentChildConfig(loadConfig());
		if (current.enabled) {
			// Never evict the child the user is actively conversing with.
			const activeKey = hostEditorConversation.active ? hostEditorConversation.targetKey : undefined;
			const activeResidentKey = activeKey ? activeKey.split(":").slice(1).join("/") : undefined;
			void persistentChildRegistry.evictIdle(current.idleEvictionMs, { except: activeResidentKey });
			void persistentChildRegistry.evictOverflow(current.maxResidentChildren, { except: activeResidentKey });
		}
	}, 60_000);
	evictionTimer.unref?.();
	const steerView = createSteerViewRuntime(state, config, {
		hostEditor: hostEditorConversation,
		getResidentChild,
	});

	const unregisterInputHandler = pi.on("input", (event) => {
		if (!hostEditorConversation.active) return { action: "continue" as const };
		return hostEditorConversation.routeInput(event);
	});
	void unregisterInputHandler;

	const supervisorChannel = createNativeSupervisorChannel(pi, state);
	const { startResultWatcher, primeExistingResults, stopResultWatcher } = createResultWatcher(
		pi,
		state,
		RESULTS_DIR,
		10 * 60 * 1000,
	);
	startResultWatcher();
	primeExistingResults();

	const runtimeCleanup = () => {
		stopResultWatcher();
		scheduledRunManager.stop();
		supervisorChannel.dispose();
		clearPendingForegroundControlNotices(state);
		if (state.poller) {
			clearInterval(state.poller);
			state.poller = null;
		}
		steerView.dispose();
		hostEditorConversation.dispose();
		clearInterval(evictionTimer);
	};
	globalStore[runtimeCleanupStoreKey] = runtimeCleanup;

	const { ensurePoller, handleStarted, handleComplete, resetJobs, restoreActiveJobs } = createAsyncJobTracker(pi, state, ASYNC_DIR);
	let executorExecute: ((id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((r: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>) | undefined;
	const scheduledRunManager = createScheduledRunManager({
		config,
		launch: (params, ctx, signal) => {
			if (!executorExecute) {
				return Promise.resolve({
					content: [{ type: "text", text: "Scheduled subagent launch is unavailable (executor not ready)." }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				});
			}
			return executorExecute(randomUUID(), params, signal, undefined, ctx);
		},
	});
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault,
		persistentChildRegistry: persistentChildRegistry,
		handleScheduledRunAction: (params, ctx) => scheduledRunManager.handleToolCall(params, ctx),
		tempArtifactsDir,
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
	});
	executorExecute = executor.execute;

	registerMessageRenderers(pi);

	const { executeSubagentCollapsed, slashBridge, promptTemplateBridge, rpcBridge } = createSubagentBridges(pi.events, state, executor.execute);

	registerSubagentTools(pi, {
		config,
		waitToolConfig,
		state,
		events: pi.events,
		execute: executeSubagentCollapsed,
		getActionableSupervisorRequests: supervisorChannel.getActionableRequests,
	});

	registerSlashCommands(pi, state, steerView.controller, hostEditorConversation);

	const eventUnsubscribeStoreKey = "__piSubagentEventUnsubscribes";
	const controlNoticeSeenStoreKey = "__piSubagentVisibleControlNotices";
	const previousEventUnsubscribes = globalStore[eventUnsubscribeStoreKey];
	if (Array.isArray(previousEventUnsubscribes)) {
		for (const unsubscribe of previousEventUnsubscribes) {
			if (typeof unsubscribe !== "function") continue;
			try {
				unsubscribe();
			} catch {
				// Best effort cleanup for stale handlers from an older reload.
			}
		}
	}
	registerSubagentNotify(pi, state, { batchConfig: config.completionBatch });

	const existingVisibleControlNotices = globalStore[controlNoticeSeenStoreKey];
	const visibleControlNotices = existingVisibleControlNotices instanceof Set ? existingVisibleControlNotices as Set<string> : new Set<string>();
	globalStore[controlNoticeSeenStoreKey] = visibleControlNotices;
	const controlEventHandler = (payload: unknown) => {
		handleSubagentControlNotice({
			pi,
			state,
			visibleControlNotices,
			details: payload as SubagentControlMessageDetails,
		});
	};
	const eventUnsubscribes = [
		pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, handleStarted),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete),
		pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
		rpcBridge.dispose,
	];
	globalStore[eventUnsubscribeStoreKey] = eventUnsubscribes;

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		if (!ctx.hasUI) return;
		state.lastUiContext = ctx;
		if (state.asyncJobs.size > 0) {
			renderWidget(ctx, Array.from(state.asyncJobs.values()));
			ctx.ui.requestRender?.();
			ensurePoller();
		}
	});

	const cleanupSessionArtifacts = (ctx: ExtensionContext) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) {
				cleanupOldArtifacts(getArtifactsDir(sessionFile), DEFAULT_ARTIFACT_CONFIG.cleanupDays);
			}
		} catch {
			// Cleanup failures should not block session lifecycle events.
		}
	};

	const resetSessionState = (ctx: ExtensionContext) => {
		state.baseCwd = ctx.cwd;
		state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
		state.subagentSpawns = { sessionId: state.currentSessionId, count: 0 };
		// Set PI_SUBAGENT_PARENT_SESSION for permission-system forwarding.
		// Only set in the root session (the interactive UI session), not in
		// child subagent processes — children inherit the parent's value
		// through the process environment at spawn time and must not overwrite
		// it with their own session identity.
		if (!process.env[SUBAGENT_CHILD_ENV]) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (sessionId) {
				process.env[SUBAGENT_PARENT_SESSION_ENV] = sessionId;
			}
		}
		state.lastUiContext = ctx;
		cleanupSessionArtifacts(ctx);
		clearPendingForegroundControlNotices(state);
		resetJobs(ctx);
		restoreActiveJobs(ctx);
		scheduledRunManager.bindSession(ctx);
		restoreSlashFinalSnapshots(ctx.sessionManager.getEntries());
		primeExistingResults();
	};

	pi.on("session_start", (_event, ctx) => {
		resetSessionState(ctx);
		steerView.startSession(ctx);
		rpcBridge.emitReady(ctx);
		supervisorChannel.start();
	});

	pi.on("session_shutdown", () => {
		delete process.env[SUBAGENT_PARENT_SESSION_ENV];
		steerView.closeSession();
		hostEditorConversation.close(undefined);
		void persistentChildRegistry.closeAll("graceful");
		for (const unsubscribe of eventUnsubscribes) {
			try {
				unsubscribe();
			} catch {
				// Best effort cleanup during shutdown.
			}
		}
		if (globalStore[eventUnsubscribeStoreKey] === eventUnsubscribes) {
			delete globalStore[eventUnsubscribeStoreKey];
		}
		stopResultWatcher();
		scheduledRunManager.stop();
		if (state.poller) clearInterval(state.poller);
		state.poller = null;
		clearPendingForegroundControlNotices(state);
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		clearSlashSnapshots();
		slashBridge.cancelAll();
		slashBridge.dispose();
		promptTemplateBridge.cancelAll();
		promptTemplateBridge.dispose();
		supervisorChannel.dispose();
		if (globalStore[runtimeCleanupStoreKey] === runtimeCleanup) {
			delete globalStore[runtimeCleanupStoreKey];
		}
		try {
			if (state.lastUiContext?.hasUI) {
				state.lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
			}
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	});
}
