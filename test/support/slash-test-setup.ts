import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ASYNC_DIR } from "../../src/shared/types.ts";

export { ASYNC_DIR };
export { fs, os, path };

export const SLASH_RESULT_TYPE = "subagent-slash-result";
export const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
export const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
export const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

export interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

export type RegisteredSlashCommand = { handler(args: string, ctx: unknown): Promise<void>; getArgumentCompletions?: (prefix: string) => unknown };

export interface RegisterSlashCommandsModule {
	registerSlashCommands?: (
		pi: {
			events: EventBus;
			registerCommand(
				name: string,
				spec: RegisteredSlashCommand,
			): void;
			registerShortcut(key: string, spec: { handler(ctx: unknown): Promise<void> }): void;
			sendMessage(message: unknown): void;
			setModel?(model: unknown): Promise<boolean>;
		},
		state: {
			baseCwd: string;
			currentSessionId: string | null;
			asyncJobs: Map<string, unknown>;
			cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
			lastUiContext: unknown;
			poller: NodeJS.Timeout | null;
			completionSeen: Map<string, number>;
			watcher: unknown;
			watcherRestartTimer: ReturnType<typeof setTimeout> | null;
			resultFileCoalescer: { schedule(file: string, delayMs?: number): boolean; clear(): void };
		},
	) => void;
}

interface SlashLiveStateModule {
	clearSlashSnapshots?: typeof import("../../src/slash/slash-live-state.ts").clearSlashSnapshots;
	getSlashRenderableSnapshot?: typeof import("../../src/slash/slash-live-state.ts").getSlashRenderableSnapshot;
	resolveSlashMessageDetails?: typeof import("../../src/slash/slash-live-state.ts").resolveSlashMessageDetails;
}

export let registerSlashCommands: RegisterSlashCommandsModule["registerSlashCommands"];
export let clearSlashSnapshots: SlashLiveStateModule["clearSlashSnapshots"];
export let getSlashRenderableSnapshot: SlashLiveStateModule["getSlashRenderableSnapshot"];
export let resolveSlashMessageDetails: SlashLiveStateModule["resolveSlashMessageDetails"];
export let available = true;
try {
	({ registerSlashCommands } = await import("../../src/slash/slash-commands.ts") as RegisterSlashCommandsModule);
	({ clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails } = await import("../../src/slash/slash-live-state.ts") as SlashLiveStateModule);
} catch {
	available = false;
}

export function createEventBus(): EventBus {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		on(event, handler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
			return () => {
				const current = handlers.get(event) ?? [];
				handlers.set(event, current.filter((entry) => entry !== handler));
			};
		},
		emit(event, data) {
			for (const handler of handlers.get(event) ?? []) {
				handler(data);
			}
		},
	};
}

export function createState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
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
}

export async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slash-home-"));
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		fs.rmSync(home, { recursive: true, force: true });
	}
}


export function createCommandContext(
	overrides: Partial<{
		cwd: string;
		hasUI: boolean;
		custom: (...args: unknown[]) => Promise<unknown>;
		notify: (message: string, type?: string) => void;
		confirm: (title: string, message: string) => Promise<boolean>;
		setStatus: (key: string, text: string | undefined) => void;
		setToolsExpanded: (expanded: boolean) => void;
		sessionManager: unknown;
		modelRegistry: { getAvailable: () => Array<{ provider: string; id: string }>; find?: (provider: string, id: string) => unknown };
	}> = {},
) {
	return {
		cwd: overrides.cwd ?? process.cwd(),
		hasUI: overrides.hasUI ?? false,
		ui: {
			notify: overrides.notify ?? ((_message: string) => {}),
			confirm: overrides.confirm ?? (async () => false),
			setStatus: overrides.setStatus ?? ((_key: string, _text: string | undefined) => {}),
			setToolsExpanded: overrides.setToolsExpanded ?? ((_expanded: boolean) => {}),
			onTerminalInput: () => () => {},
			custom: overrides.custom ?? (async () => undefined),
		},
		modelRegistry: overrides.modelRegistry ?? { getAvailable: () => [], find: () => undefined },
		sessionManager: overrides.sessionManager ?? {
			getSessionFile: () => null,
			getSessionId: () => "session-test",
		},
	};
}

export async function withTempProject<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
	fs.mkdirSync(path.join(root, ".pi", "chains"), { recursive: true });
	try {
		return await fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

export function writeProjectChain(root: string, fileName: string, content: string): void {
	fs.writeFileSync(path.join(root, ".pi", "chains", fileName), content, "utf-8");
}

export async function captureSlashCommandParams(
	commandName: string,
	args: string,
	cwd: string,
	setup?: () => void,
): Promise<{ params: unknown; notifications: string[] }> {
	return withIsolatedHome(async () => {
		setup?.();
		const commands = new Map<string, RegisteredSlashCommand>();
		const events = createEventBus();
		let requestedParams: unknown;
		const notifications: string[] = [];
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: `${commandName} finished` }],
					details: { mode: "chain", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: RegisteredSlashCommand) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(_message: unknown) {},
		};

		registerSlashCommands!(pi, createState(cwd));
		await commands.get(commandName)!.handler(args, createCommandContext({
			cwd,
			notify: (message) => {
				notifications.push(message);
			},
		}));
		return { params: requestedParams, notifications };
	});
}
