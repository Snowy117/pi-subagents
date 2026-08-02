import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChildKeybindings } from "../../src/tui/child-conversation/child-keybindings.ts";
import { createChildKeyRoute } from "../../src/tui/steer-view/child-key-route.ts";
import type { ChildConversationChannel } from "../../src/tui/child-conversation/channel.ts";
import { makeChildKeybindingsManager } from "../support/child-keybindings.ts";

const ESC = "\u001b";
const CTRL_P = "\u0010";
const CTRL_N = "\u000e";
const CTRL_L = "\u000c";
const CTRL_O = "\u000f";
const CTRL_T = "\u0014";
const SHIFT_TAB = `${ESC}[Z`;

interface FakeChannel extends ChildConversationChannel {
	sent: Array<Record<string, unknown>>;
	emit(line: string): void;
	emitResponse(id: string, command: string, data?: unknown): void;
}

function makeChannel(): FakeChannel {
	const sent: Array<Record<string, unknown>> = [];
	const subscribers = new Set<(line: string) => void>();
	let counter = 0;
	const channel: FakeChannel = {
		key: "run-1/0",
		settled: true,
		closed: new Promise<void>(() => {}),
		lastActivityAt: 0,
		sent,
		write(record) {
			const id = `rid-${++counter}`;
			sent.push({ ...record, id });
			return id;
		},
		onStdoutLine(cb) {
			subscribers.add(cb);
			return () => subscribers.delete(cb);
		},
		touch() {
			channel.lastActivityAt = Date.now();
		},
		close: async () => {},
		emit(line) {
			for (const cb of subscribers) cb(line);
		},
		emitResponse(id, command, data) {
			channel.emit(JSON.stringify({ id, type: "response", command, success: true, data }));
		},
	};
	return channel;
}

function makeUi() {
	const notices: Array<{ message: string; level?: string }> = [];
	const selectCalls: unknown[] = [];
	let selectResult: string | undefined;
	const ui = {
		notify(message: string, level?: "info" | "warning" | "error") {
			notices.push({ message, level });
		},
		async select(title: string, options: string[]) {
			selectCalls.push({ title, options });
			return selectResult;
		},
		requestRender() {},
	};
	return {
		notices,
		selectCalls,
		setSelectResult(result: string | undefined) { selectResult = result; },
		ui,
	};
}

function makeRoute(overrides: { streaming?: boolean } = {}) {
	const channel = makeChannel();
	const ui = makeUi();
	let streaming = overrides.streaming ?? false;
	let toolsExpanded = false;
	let thinkingHidden = false;
	// Isolated keybindings: never read the host machine's keybindings.json so
	// tests are deterministic (the real file remaps ctrl+l/o/t on this box).
	const keybindings = createChildKeybindings({ manager: makeChildKeybindingsManager() });
	const route = createChildKeyRoute({
		getActiveChannel: () => channel,
		isStreaming: () => streaming,
		getUi: () => ui.ui,
		onToolsExpand: () => { toolsExpanded = !toolsExpanded; },
		onThinkingToggle: () => { thinkingHidden = !thinkingHidden; },
		keybindings,
	});
	return {
		channel,
		ui,
		route,
		setStreaming(value: boolean) { streaming = value; },
		getToolsExpanded() { return toolsExpanded; },
		getThinkingHidden() { return thinkingHidden; },
	};
}

describe("child key route", () => {
	it("does nothing when no child mode channel is active", () => {
		const ui = makeUi();
		const route = createChildKeyRoute({
			getActiveChannel: () => undefined,
			isStreaming: () => false,
			getUi: () => ui.ui,
			onToolsExpand: () => {},
			onThinkingToggle: () => {},
		});
		assert.equal(route.handleInput(ESC), undefined);
		route.dispose();
	});

	it("aborts the child on Esc only while streaming; passes through when idle", () => {
		const { channel, route, setStreaming } = makeRoute();
		assert.equal(route.handleInput(ESC), undefined, "idle Esc passes through to the editor");
		assert.equal(channel.sent.length, 0);
		setStreaming(true);
		const result = route.handleInput(ESC);
		assert.deepEqual(result, { consume: true });
		assert.equal(channel.sent[0]!.type, "abort");
	});

	it("routes thinking.cycle to the child and surfaces the level", async () => {
		const { channel, route, ui } = makeRoute();
		assert.deepEqual(route.handleInput(SHIFT_TAB), { consume: true });
		assert.equal(channel.sent[0]!.type, "cycle_thinking_level");
		const id = channel.sent[0]!.id as string;
		channel.emitResponse(id, "cycle_thinking_level", { level: "high" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(ui.notices.some((n) => n.message.includes("high")));
	});

	it("routes model.cycleForward to the child and surfaces the model name", async () => {
		const { channel, route, ui } = makeRoute();
		assert.deepEqual(route.handleInput(CTRL_P), { consume: true });
		assert.equal(channel.sent[0]!.type, "cycle_model");
		const id = channel.sent[0]!.id as string;
		channel.emitResponse(id, "cycle_model", { model: { provider: "anthropic", id: "claude-x", name: "Claude X" } });
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(ui.notices.some((n) => n.message.includes("Claude X")));
	});

	it("routes model.cycleBackward via get_state + get_available_models → set_model(prev)", async () => {
		// shift+ctrl+p is not resolvable from legacy terminal bytes, so the
		// route is exercised through an injected keybindings remap.
		const keybindings = createChildKeybindings({ manager: makeChildKeybindingsManager({ "app.model.cycleBackward": "ctrl+n" }) });
		const channel = makeChannel();
		const ui = makeUi();
		const route = createChildKeyRoute({
			getActiveChannel: () => channel,
			isStreaming: () => false,
			getUi: () => ui.ui,
			onToolsExpand: () => {},
			onThinkingToggle: () => {},
			keybindings,
		});
		assert.deepEqual(route.handleInput(CTRL_N), { consume: true });
		const stateRequest = channel.sent.find((record) => record.type === "get_state");
		const modelsRequest = channel.sent.find((record) => record.type === "get_available_models");
		assert.ok(stateRequest && modelsRequest, "cycleBackward needs the current state and the model list");
		channel.emitResponse(stateRequest!.id as string, "get_state", {
			model: { provider: "anthropic", id: "m2", name: "Model 2" },
		});
		channel.emitResponse(modelsRequest!.id as string, "get_available_models", {
			models: [
				{ provider: "anthropic", id: "m1", name: "Model 1" },
				{ provider: "anthropic", id: "m2", name: "Model 2" },
				{ provider: "anthropic", id: "m3", name: "Model 3" },
			],
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		const setModel = channel.sent.find((record) => record.type === "set_model");
		assert.ok(setModel, "cycleBackward writes the previous model");
		assert.equal(setModel!.provider, "anthropic");
		assert.equal(setModel!.modelId, "m1");
		assert.ok(ui.notices.some((n) => n.message.includes("Model 1")));
	});

	it("routes model.select through the viewer picker and set_model", async () => {
		const { channel, route, ui } = makeRoute();
		ui.setSelectResult("Claude X");
		assert.deepEqual(route.handleInput(CTRL_L), { consume: true });
		// First request should be get_available_models.
		const modelsRequest = channel.sent.find((record) => record.type === "get_available_models");
		assert.ok(modelsRequest, "model.select fetches the available models");
		const id = modelsRequest!.id as string;
		channel.emitResponse(id, "get_available_models", {
			models: [
				{ provider: "anthropic", id: "claude-1", name: "Claude 1" },
				{ provider: "anthropic", id: "claude-x", name: "Claude X" },
			],
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(ui.selectCalls.length, 1);
		const selectArgs = ui.selectCalls[0] as { options: string[] };
		assert.deepEqual(selectArgs.options, ["Claude 1", "Claude X"]);
		const setModel = channel.sent.find((record) => record.type === "set_model");
		assert.deepEqual(setModel, { type: "set_model", provider: "anthropic", modelId: "claude-x", id: setModel!.id });
	});

	it("toggles local tools expansion state on tools.expand", () => {
		const { route, getToolsExpanded } = makeRoute();
		assert.deepEqual(route.handleInput(CTRL_O), { consume: true });
		assert.equal(getToolsExpanded(), true);
		assert.deepEqual(route.handleInput(CTRL_O), { consume: true });
		assert.equal(getToolsExpanded(), false);
	});

	it("toggles local thinking-hidden state on thinking.toggle", () => {
		const { route, getThinkingHidden } = makeRoute();
		assert.deepEqual(route.handleInput(CTRL_T), { consume: true });
		assert.equal(getThinkingHidden(), true);
		assert.deepEqual(route.handleInput(CTRL_T), { consume: true });
		assert.equal(getThinkingHidden(), false);
	});

	it("leaves editing-level keys untouched", () => {
		const { route, channel } = makeRoute();
		assert.equal(route.handleInput("a"), undefined);
		assert.equal(route.handleInput("\u0003"), undefined, "ctrl+c (clear) is not intercepted");
		assert.equal(route.handleInput("\u0004"), undefined, "ctrl+d (exit) is not intercepted");
		assert.equal(route.handleInput("\r"), undefined, "enter is not intercepted");
		assert.equal(channel.sent.length, 0);
	});

	it("dispose unsubscribes from the channel stdout", () => {
		const { channel, route } = makeRoute();
		route.dispose();
		// After dispose the route must stay silent.
		assert.equal(route.handleInput(ESC), undefined);
		assert.equal(route.handleInput(CTRL_L), undefined);
		assert.equal(channel.sent.length, 0);
	});
});