import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSteerViewController, type SteerViewController } from "../../src/tui/steer-view/open-view.ts";
import { registerSlashCommands } from "../../src/slash/slash-commands.ts";
import { createEventBus, createState, type RegisteredSlashCommand } from "../support/slash-test-setup.ts";

describe("interactive subagent view entry", () => {
	it("registers /subagents as the exact package slash-command surface", async () => {
		const commands = new Map<string, RegisteredSlashCommand>();
		let opens = 0;
		const controller = { modalOpen: false, open: async () => { opens++; }, close: () => {}, dispose: () => {} } as SteerViewController;
		registerSlashCommands({
			events: createEventBus(), registerCommand: (name, spec) => commands.set(name, spec as RegisteredSlashCommand),
			registerShortcut() {}, sendMessage() {},
		} as never, createState("/tmp") as never, controller);
		assert.deepEqual([...commands.keys()], ["subagents"]);
		await commands.get("subagents")!.handler("", { hasUI: false } as never);
		assert.equal(opens, 0);
		await commands.get("subagents")!.handler("", { hasUI: true } as never);
		assert.equal(opens, 1);
	});

	it("closes the full overlay before prefilling slash text", async () => {
		const state = createState("/tmp") as ReturnType<typeof createState> & {
			foregroundRuns: Map<string, unknown>; foregroundLiveChildren: Map<string, unknown>; foregroundControls: Map<string, unknown>; lastForegroundControlId: null;
		};
		state.foregroundRuns = new Map();
		state.foregroundLiveChildren = new Map([["run:0", {
			runId: "run", index: 0, agent: "worker", status: "running", controlRoot: "/control",
			steerInboxDir: "/steer", actionControlDir: "/action", updatedAt: 1,
		}]]);
		state.foregroundControls = new Map();
		state.lastForegroundControlId = null;
		const order: string[] = [];
		let customCall = 0;
		const ctx = {
			hasUI: true,
			ui: {
				notify() {},
				custom: async (_factory: unknown, options: { overlay: boolean; overlayOptions: Record<string, unknown> }) => {
					customCall++;
					if (customCall === 1) return [...state.foregroundLiveChildren.values()][0];
					assert.deepEqual(options, { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 } });
					order.push("overlay-resolved");
					return { kind: "slash", text: "/plugin-command" };
				},
				setEditorText: (text: string) => order.push(`prefill:${text}`),
			},
		} as unknown as ExtensionContext;
		const controller = createSteerViewController(state as never, { listRuns: () => [] });
		await controller.open(ctx);
		assert.deepEqual(order, ["overlay-resolved", "prefill:/plugin-command"]);
	});

	it("closes a session modal without reopening the picker and remains reusable", async () => {
		const state = createState("/tmp") as ReturnType<typeof createState> & {
			foregroundRuns: Map<string, unknown>; foregroundLiveChildren: Map<string, unknown>; foregroundControls: Map<string, unknown>; lastForegroundControlId: null;
		};
		state.foregroundRuns = new Map();
		state.foregroundLiveChildren = new Map([["run:0", {
			runId: "run", index: 0, agent: "worker", status: "running", controlRoot: "/control",
			steerInboxDir: "/steer", actionControlDir: "/action", updatedAt: 1,
		}]]);
		state.foregroundControls = new Map();
		state.lastForegroundControlId = null;
		let customCalls = 0;
		let closeChat: ((result: unknown) => void) | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				notify() {}, setEditorText() {},
				custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: unknown) => void) => unknown) => {
					customCalls++;
					if (customCalls === 1 || customCalls === 3) return [...state.foregroundLiveChildren.values()][0];
					if (customCalls === 4) return { kind: "slash", text: "/done" };
					return new Promise((resolve) => {
						closeChat = resolve;
						factory({ terminal: { rows: 10 }, requestRender() {} }, { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text }, undefined, resolve);
					});
				},
			},
		} as unknown as ExtensionContext;
		const controller = createSteerViewController(state as never, { listRuns: () => [] });
		const firstOpen = controller.open(ctx);
		for (let attempt = 0; attempt < 10 && !closeChat; attempt++) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		assert.equal(typeof closeChat, "function");
		controller.close();
		await firstOpen;
		assert.equal(customCalls, 2);
		await controller.open(ctx);
		assert.equal(customCalls, 4);
	});

	it("uses terminal listeners without replacing a CustomEditor", () => {
		const uiCalls: string[] = [];
		const ui = {
			onTerminalInput: () => { uiCalls.push("terminal-listener"); return () => {}; },
			setEditorComponent: () => uiCalls.push("editor-replaced"),
		};
		ui.onTerminalInput();
		assert.deepEqual(uiCalls, ["terminal-listener"]);
	});

	it("keeps the slash command usable when an earlier terminal listener consumes Down", async () => {
		let opens = 0;
		const earlierListener = () => ({ consume: true });
		assert.deepEqual(earlierListener(), { consume: true });
		const controller = { modalOpen: false, open: async () => { opens++; }, close() {}, dispose() {} } as SteerViewController;
		const commands = new Map<string, RegisteredSlashCommand>();
		registerSlashCommands({
			events: createEventBus(), registerCommand: (name, spec) => commands.set(name, spec as RegisteredSlashCommand),
			registerShortcut() {}, sendMessage() {},
		} as never, createState("/tmp") as never, controller);
		await commands.get("subagents")!.handler("", { hasUI: true } as never);
		assert.equal(opens, 1);
	});
});

describe("host editor routing mode entry", () => {
	it("/subagents exit closes the host-editor conversation", async () => {
		const commands = new Map<string, RegisteredSlashCommand>();
		let closed = false;
		const hostEditor = {
			active: true,
			targetKey: "foreground:run:0",
			open: () => true,
			close: () => { closed = true; },
			routeInput: () => ({ action: "continue" }),
			dispose: () => {},
		};
		const controller = { modalOpen: true, open: async () => {}, close: () => {}, dispose: () => {} } as SteerViewController;
		registerSlashCommands({
			events: createEventBus(), registerCommand: (name, spec) => commands.set(name, spec as RegisteredSlashCommand),
			registerShortcut() {}, sendMessage() {},
		} as never, createState("/tmp") as never, controller, hostEditor as never);
		const notifyCalls: string[] = [];
		await commands.get("subagents")!.handler("exit", { hasUI: true, ui: { notify: (text: string) => notifyCalls.push(text) } } as never);
		assert.equal(closed, true);
		assert.ok(notifyCalls.some((text) => text.includes("returns to the parent")), `notify calls: ${JSON.stringify(notifyCalls)}`);
	});

	it("activates host-editor mode from the picker when a resident child exists", async () => {
		const state = createState("/tmp") as ReturnType<typeof createState> & {
			foregroundRuns: Map<string, unknown>; foregroundLiveChildren: Map<string, unknown>; foregroundControls: Map<string, unknown>; lastForegroundControlId: null;
		};
		state.foregroundRuns = new Map();
		state.foregroundLiveChildren = new Map([["run:0", {
			runId: "run", index: 0, agent: "worker", status: "running", controlRoot: "/control",
			steerInboxDir: "/steer", actionControlDir: "/action", updatedAt: 1,
		}]]);
		state.foregroundControls = new Map();
		state.lastForegroundControlId = null;
		const resident = {
			key: "run/0",
			proc: {} as never,
			write: { writeLine: () => true, write: () => "req", close: () => {} },
			settled: true,
			lastActivityAt: 0,
			pendingDialogs: new Map(),
			pendingRequestIds: new Set(),
			closed: new Promise(() => {}),
			close: async () => {},
		};
		let hostEditorOpened = false;
		const hostEditorState = { active: false, targetKey: undefined as string | undefined };
		const hostEditor = {
			get active() { return hostEditorState.active; },
			get targetKey() { return hostEditorState.targetKey; },
			open: (ctx: unknown, target: { key: string }) => {
				hostEditorOpened = true;
				hostEditorState.active = true;
				hostEditorState.targetKey = target.key;
				return true;
			},
			close: () => { hostEditorState.active = false; },
			routeInput: () => ({ action: "continue" }),
			dispose: () => {},
		};
		const widgets = new Map<string, unknown>();
		let notified = "";
		const ctx = {
			hasUI: true,
			ui: {
				notify: (text: string) => { notified = text; },
				setWidget: (key: string, content: unknown) => {
					if (content === undefined) widgets.delete(key);
					else widgets.set(key, content);
				},
				custom: async () => ({ key: "foreground:run:0", kind: "foreground", runId: "run", index: 0, agent: "worker", status: "completed", active: false, updatedAt: 1 }),
			},
		} as unknown as ExtensionContext;
		const controller = createSteerViewController(state as never, {
			listRuns: () => [],
			hostEditor: hostEditor as never,
			getResidentChild: () => resident as never,
		});
		await controller.open(ctx);
		assert.equal(hostEditorOpened, true);
		assert.ok(notified.includes("child mode"));
	});
});

describe("host editor target switch", () => {
	it("switches the active host-editor conversation to a newly selected child", async () => {
		const state = createState("/tmp") as ReturnType<typeof createState> & {
			foregroundRuns: Map<string, unknown>; foregroundLiveChildren: Map<string, unknown>; foregroundControls: Map<string, unknown>; lastForegroundControlId: null;
		};
		state.foregroundRuns = new Map();
		state.foregroundLiveChildren = new Map([
			["run-a:0", { runId: "run-a", index: 0, agent: "worker-a", status: "running", controlRoot: "/a", steerInboxDir: "/sa", actionControlDir: "/aa", updatedAt: 1 }],
			["run-b:0", { runId: "run-b", index: 0, agent: "worker-b", status: "running", controlRoot: "/b", steerInboxDir: "/sb", actionControlDir: "/ab", updatedAt: 2 }],
		]);
		state.foregroundControls = new Map();
		state.lastForegroundControlId = null;
		const resident = {
			key: "run/0",
			proc: {} as never,
			write: { writeLine: () => true, write: () => "req", close: () => {} },
			settled: true,
			lastActivityAt: 0,
			pendingDialogs: new Map(),
			pendingRequestIds: new Set(),
			closed: new Promise(() => {}),
			close: async () => {},
		};
		const hostEditorState = { active: false, targetKey: undefined as string | undefined };
		const openedKeys: string[] = [];
		const closedCount = { value: 0 };
		const hostEditor = {
			get active() { return hostEditorState.active; },
			get targetKey() { return hostEditorState.targetKey; },
			open: (ctx: unknown, target: { key: string }) => {
				openedKeys.push(target.key);
				hostEditorState.active = true;
				hostEditorState.targetKey = target.key;
				return true;
			},
			close: () => { closedCount.value++; hostEditorState.active = false; },
			routeInput: () => ({ action: "continue" }),
			dispose: () => {},
		};
		let pickerCall = 0;
		const ctx = {
			hasUI: true,
			ui: {
				notify() {},
				setWidget() {},
				custom: async () => {
					pickerCall++;
					if (pickerCall === 1) return { key: "foreground:run-a:0", kind: "foreground", runId: "run-a", index: 0, agent: "worker-a", status: "running", active: true, updatedAt: 1 };
					if (pickerCall === 2) return { key: "foreground:run-b:0", kind: "foreground", runId: "run-b", index: 0, agent: "worker-b", status: "running", active: true, updatedAt: 2 };
					return undefined;
				},
			},
		} as unknown as ExtensionContext;
		const controller = createSteerViewController(state as never, {
			listRuns: () => [],
			hostEditor: hostEditor as never,
			getResidentChild: () => resident as never,
		});
		// First /subagents: activate host-editor mode for run-a.
		await controller.open(ctx);
		assert.equal(hostEditorState.active, true);
		assert.equal(hostEditorState.targetKey, "foreground:run-a:0");
		// Second /subagents: picker opens again and switching target closes the
		// old conversation and routes to the new child.
		await controller.open(ctx);
		assert.deepEqual(openedKeys, ["foreground:run-a:0", "foreground:run-b:0"]);
		assert.equal(closedCount.value, 1, "switching target closes the previous conversation");
		assert.equal(hostEditorState.active, true);
		assert.equal(hostEditorState.targetKey, "foreground:run-b:0");
	});
});
