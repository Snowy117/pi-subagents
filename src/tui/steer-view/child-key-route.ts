/**
 * Child-mode app-level key routing (R1b / Q5=A).
 *
 * While child mode is active the viewer intercepts the 7 app-level actions
 * (Esc abort, thinking/model cycling and selection, tools expand, thinking
 * toggle) and routes them to the child through the active
 * ChildConversationChannel — operating the child "like the main agent".
 * Register the returned handleInput with `ctx.ui.onTerminalInput`.
 *
 * Esc is consumed only while the child is streaming (it aborts, matching the
 * main view's Esc semantics); when idle it passes through so the editor keeps
 * its "close autocomplete" behavior. Editing-level keys are never handled.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildConversationChannel } from "../child-conversation/channel.ts";
import { createChildKeybindings, type ChildKeybindings } from "../child-conversation/child-keybindings.ts";

const RESPONSE_TIMEOUT_MS = 2000;

interface RpcResponseRecord {
	id?: string;
	type?: string;
	command?: string;
	success?: boolean;
	data?: unknown;
	error?: string;
}

interface ModelLike {
	provider?: string;
	id?: string;
	name?: string;
}

interface StatePacket {
	model?: ModelLike;
}

function asResponse(value: unknown): RpcResponseRecord {
	return (value && typeof value === "object" ? value : {}) as RpcResponseRecord;
}

function asModels(value: unknown): ModelLike[] {
	const data = (value && typeof value === "object" ? value : {}) as { models?: unknown };
	if (!Array.isArray(data.models)) return [];
	return data.models.filter((m): m is ModelLike => typeof m === "object" && m !== null);
}

function asState(value: unknown): StatePacket {
	return (value && typeof value === "object" ? value : {}) as StatePacket;
}

function modelLabel(model: ModelLike): string {
	return model.name || (model.provider && model.id ? `${model.provider}/${model.id}` : "?");
}

export interface ChildKeyRouteDeps {
	getActiveChannel: () => ChildConversationChannel | undefined;
	/** True while the child is streaming (prompt in flight until agent_settled). */
	isStreaming: () => boolean;
	/** Lazy UI accessor for select/notify/requestRender (child mode active ⇒ set). */
	getUi: () => ExtensionContext["ui"] | undefined;
	/** Toggle the child view's local tool-output expansion state. */
	onToolsExpand: () => void;
	/** Toggle the child view's local hide-thinking override. */
	onThinkingToggle: () => void;
	keybindings?: ChildKeybindings;
}

export interface ChildKeyRoute {
	/** Route a raw terminal input; returns { consume: true } only when the key
	 *  was routed to the child or applied locally. */
	handleInput(data: string): { consume: true } | undefined;
	dispose(): void;
}

export function createChildKeyRoute(deps: ChildKeyRouteDeps): ChildKeyRoute {
	const { getActiveChannel, isStreaming, getUi, onToolsExpand, onThinkingToggle } = deps;
	const keybindings = deps.keybindings ?? createChildKeybindings();
	const pendingRequests = new Map<string, (record: RpcResponseRecord) => void>();
	let subscribedChannel: ChildConversationChannel | undefined;
	let unsubscribe: (() => void) | undefined;
	let lastKnownModel: ModelLike | undefined;
	let disposed = false;

	const onRpcLine = (line: string): void => {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			return;
		}
		const record = asResponse(raw);
		if (!record.id || record.type !== "response") return;
		const handler = pendingRequests.get(record.id);
		if (!handler) return;
		pendingRequests.delete(record.id);
		handler(record);
	};

	const ensureSubscription = (channel: ChildConversationChannel): void => {
		if (disposed) return;
		// Track the channel instance, not its key: a reopen swap replaces the
		// channel object while keeping the same key, and responses must be
		// listened for on the CURRENT channel.
		if (subscribedChannel === channel && unsubscribe) return;
		unsubscribe?.();
		subscribedChannel = channel;
		unsubscribe = channel.onStdoutLine(onRpcLine);
	};

	/** Send a request and resolve with its response record (timeout → undefined). */
	const request = (channel: ChildConversationChannel, record: Record<string, unknown>): Promise<RpcResponseRecord | undefined> => {
		return new Promise((resolve) => {
			const id = channel.write(record);
			const timer = setTimeout(() => {
				if (pendingRequests.delete(id)) resolve(undefined);
			}, RESPONSE_TIMEOUT_MS);
			timer.unref?.();
			pendingRequests.set(id, (response) => {
				clearTimeout(timer);
				resolve(response);
			});
		});
	};

	const requestModels = async (channel: ChildConversationChannel): Promise<ModelLike[]> => {
		const response = await request(channel, { type: "get_available_models" });
		return response?.success ? asModels(response.data) : [];
	};

	const setModel = (channel: ChildConversationChannel, model: ModelLike): void => {
		void request(channel, { type: "set_model", provider: model.provider ?? "", modelId: model.id ?? "" });
	};

	const handleInterrupt = (channel: ChildConversationChannel): boolean => {
		if (!isStreaming()) return false;
		channel.write({ type: "abort" });
		return true;
	};

	const handleThinkingCycle = async (channel: ChildConversationChannel, ui: ExtensionContext["ui"]): Promise<void> => {
		const response = await request(channel, { type: "cycle_thinking_level" });
		const level = response?.success && response.data
			? (response.data as { level?: unknown }).level
			: undefined;
		if (typeof level === "string") {
			notify(ui, `Child thinking level: ${level}`, "info");
		}
	};

	const handleModelCycleForward = async (channel: ChildConversationChannel, ui: ExtensionContext["ui"]): Promise<void> => {
		const response = await request(channel, { type: "cycle_model" });
		const data = response?.success && response.data ? response.data as { model?: ModelLike } : undefined;
		if (data?.model) {
			lastKnownModel = data.model;
			notify(ui, `Child model: ${modelLabel(data.model)}`, "info");
		}
	};

	const handleModelCycleBackward = async (channel: ChildConversationChannel, ui: ExtensionContext["ui"]): Promise<void> => {
		const [stateResponse, models] = await Promise.all([
			request(channel, { type: "get_state" }),
			requestModels(channel),
		]);
		if (!models.length) return;
		const current = stateResponse?.success ? asState(stateResponse.data).model : lastKnownModel;
		const index = current ? models.findIndex((m) => m.provider === current.provider && m.id === current.id) : -1;
		// Wrap: index 0 → last, not-found → first.
		const previous = index > 0 ? models[index - 1] : index === 0 ? models[models.length - 1] : models[0];
		lastKnownModel = previous;
		setModel(channel, previous);
		notify(ui, `Child model: ${modelLabel(previous)}`, "info");
	};

	const handleModelSelect = async (channel: ChildConversationChannel, ui: ExtensionContext["ui"]): Promise<void> => {
		const models = await requestModels(channel);
		if (!models.length) return;
		const labels = models.map(modelLabel);
		const choice = await ui.select("Select child model", labels);
		if (choice === undefined) return;
		const index = labels.indexOf(choice);
		const selected = index >= 0 ? models[index] : undefined;
		if (!selected) return;
		lastKnownModel = selected;
		setModel(channel, selected);
	};

	const notify = (ui: ExtensionContext["ui"], message: string, level?: "info" | "warning" | "error"): void => {
		try {
			ui.notify(message, level);
		} catch {
			// notify is best-effort; a stale UI context must not crash routing.
		}
	};

	return {
		handleInput(data: string): { consume: true } | undefined {
			if (disposed) return undefined;
			const channel = getActiveChannel();
			if (!channel) return undefined;
			const action = keybindings.actionForKey(data);
			if (!action) return undefined;
			const ui = getUi();
			ensureSubscription(channel);
			channel.touch();
			switch (action) {
				case "interrupt":
					return handleInterrupt(channel) ? { consume: true } : undefined;
				case "thinking.cycle":
					if (ui) void handleThinkingCycle(channel, ui);
					return { consume: true };
				case "model.cycleForward":
					if (ui) void handleModelCycleForward(channel, ui);
					return { consume: true };
				case "model.cycleBackward":
					if (ui) void handleModelCycleBackward(channel, ui);
					return { consume: true };
				case "model.select":
					if (ui) void handleModelSelect(channel, ui);
					return { consume: true };
				case "tools.expand":
					onToolsExpand();
					return { consume: true };
				case "thinking.toggle":
					onThinkingToggle();
					return { consume: true };
				default:
					return undefined;
			}
		},
		dispose() {
			disposed = true;
			unsubscribe?.();
			unsubscribe = undefined;
			subscribedChannel = undefined;
			pendingRequests.clear();
		},
	};
}