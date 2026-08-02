/**
 * Child RPC command validation (//name slash routing).
 *
 * `validateAndExecuteCommand` never lets an unknown `//name` fall through to
 * a child LLM prompt: it refreshes the child's `get_commands` list over the
 * active ChildConversationChannel (request-id correlated) and only then sends
 * the slash command as a prompt. Timeout/no-stdout results are not cached; a
 * stale refresh resolving after a target switch never writes one child's
 * command set into the command cache of a different active child.
 */

import type { InputEvent } from "@earendil-works/pi-coding-agent";
import type { ChildConversationChannel } from "../child-conversation/channel.ts";

const COMMAND_CACHE_TTL_MS = 30_000;

export interface ChildCommandValidator {
	refreshCommands(): Promise<Set<string>>;
	validateAndExecute(name: string, args: string, streamingBehavior: InputEvent["streamingBehavior"]): Promise<boolean>;
	/** Drop the cache and pending request (called on conversation open/close). */
	reset(): void;
}

export interface ChildCommandValidatorDeps {
	getChannel: () => ChildConversationChannel | undefined;
	getResidentKey: () => string | undefined;
	notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

export function createChildCommandValidator(deps: ChildCommandValidatorDeps): ChildCommandValidator {
	const { getChannel, getResidentKey, notify } = deps;
	let commandCache: Set<string> | undefined;
	let commandCacheAt = 0;
	let commandCachePending: Promise<Set<string>> | undefined;

	const refreshCommands = (): Promise<Set<string>> => {
		if (commandCache && Date.now() - commandCacheAt < COMMAND_CACHE_TTL_MS) {
			return Promise.resolve(commandCache);
		}
		if (commandCachePending) return commandCachePending;
		const channel = getChannel();
		const requestingKey = getResidentKey();
		commandCachePending = new Promise((resolve) => {
			let settled = false;
			let removeListener: (() => void) | undefined;
			const finish = (names: Set<string>, cache: boolean): void => {
				if (settled) return;
				settled = true;
				removeListener?.();
				commandCachePending = undefined;
				// A stale refresh resolving after a target switch must not
				// write one child's command set into the cache of another.
				if (cache && getResidentKey() === requestingKey) {
					commandCache = names;
					commandCacheAt = Date.now();
				}
				resolve(names);
			};
			if (!channel) {
				finish(new Set(), false);
				return;
			}
			const timeout = setTimeout(() => finish(new Set(), false), 2000);
			timeout.unref?.();
			const requestId = channel.write({ type: "get_commands" });
			removeListener = channel.onStdoutLine((line) => {
				let record: { id?: string; type?: string; data?: { commands?: Array<{ name?: string }> } };
				try {
					record = JSON.parse(line) as typeof record;
				} catch {
					return;
				}
				if (record.id !== requestId || record.type !== "response") return;
				const names = new Set<string>();
				for (const command of record.data?.commands ?? []) {
					if (command?.name) names.add(command.name);
				}
				clearTimeout(timeout);
				finish(names, true);
			});
		});
		return commandCachePending;
	};

	const validateAndExecute = async (name: string, args: string, streamingBehavior: InputEvent["streamingBehavior"]): Promise<boolean> => {
		const commands = await refreshCommands();
		if (!commands.has(name)) {
			notify?.(`Child command /${name} is unavailable in the selected agent's runtime.`, "warning");
			return false;
		}
		getChannel()?.write({
			type: "prompt",
			message: `/${name}${args ? ` ${args}` : ""}`,
			streamingBehavior,
		});
		return true;
	};

	return {
		refreshCommands,
		async validateAndExecute(name, args, streamingBehavior) {
			return validateAndExecute(name, args, streamingBehavior);
		},
		reset() {
			commandCache = undefined;
			commandCacheAt = 0;
			commandCachePending = undefined;
		},
	};
}