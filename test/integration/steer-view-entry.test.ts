import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSteerViewController, type SteerViewController } from "../../src/tui/steer-view/open-view.ts";
import { registerSlashCommands } from "../../src/slash/slash-commands.ts";
import { createEventBus, createState, type RegisteredSlashCommand } from "../support/slash-test-setup.ts";

describe("interactive subagent view entry", () => {
	it("registers /subagents while preserving /subagents-fleet", async () => {
		const commands = new Map<string, RegisteredSlashCommand>();
		let opens = 0;
		const controller = { modalOpen: false, open: async () => { opens++; }, close: () => {}, dispose: () => {} } as SteerViewController;
		registerSlashCommands({
			events: createEventBus(), registerCommand: (name, spec) => commands.set(name, spec as RegisteredSlashCommand),
			registerShortcut() {}, sendMessage() {},
		} as never, createState("/tmp") as never, controller);
		assert.ok(commands.has("subagents"));
		assert.ok(commands.has("subagents-fleet"));
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
