import { BUILTIN_AGENT_NAMES, discoverAgents, discoverAgentsAll, type ChainConfig } from "../../agents/agents.ts";
import type { SubagentState } from "../../shared/types.ts";

export const makeAgentCompletions = (state: SubagentState, multiAgent: boolean) => (prefix: string) => {
	if (!state.baseCwd) return null;
	const agents = discoverAgents(state.baseCwd, "both").agents;
	if (!multiAgent) {
		if (prefix.includes(" ")) return null;
		return agents.filter((a) => a.name.startsWith(prefix)).map((a) => ({ value: a.name, label: a.name }));
	}

	// Find the start of the current chain step: after the last top-level `->` arrow or `(`,
	// or after a `|` *inside* a group. A `|` at depth 0 is plain task text (only `(` opens a
	// group), so it must not restart agent completion — otherwise `scout -- do x | wr` would
	// wrongly resume suggesting agents past the `--` task. Quotes are tracked so separators
	// inside a task are ignored.
	let inSingle = false, inDouble = false, depth = 0, segStart = 0;
	for (let i = 0; i < prefix.length; i++) {
		const ch = prefix[i]!;
		if (inSingle) { if (ch === "'") inSingle = false; continue; }
		if (inDouble) { if (ch === '"') inDouble = false; continue; }
		if (ch === "'") { inSingle = true; continue; }
		if (ch === '"') { inDouble = true; continue; }
		if (ch === "(") {
			if (!prefix.slice(segStart, i).includes(" -- ")) {
				depth++;
				segStart = i + 1;
			}
		}
		else if (ch === ")") {
			if (depth > 0) {
				depth--;
				segStart = i + 1;
			}
		}
		else if (ch === "|" && depth > 0) segStart = i + 1;
		else if (ch === ">" && prefix[i - 1] === "-" && depth === 0) segStart = i + 1;
	}
	// Inside an open quote, or once the task has started (`--` / a quote), we are no
	// longer typing an agent name.
	if (inSingle || inDouble) return null;
	const segment = prefix.slice(segStart);
	if (segment.includes(" -- ") || segment.includes('"') || segment.includes("'")) return null;

	const lastWord = (segment.match(/(\S*)$/) || ["", ""])[1];
	let beforeLastWord = prefix.slice(0, prefix.length - lastWord.length);
	// A bare `->` or `|` just typed (no trailing space) needs a separating space;
	// `(` glues naturally to the agent name.
	if (lastWord === "" && /[>|]$/.test(beforeLastWord)) beforeLastWord = `${beforeLastWord} `;

	return agents.filter((a) => a.name.startsWith(lastWord)).map((a) => ({ value: `${beforeLastWord}${a.name}`, label: a.name }));
};

export const discoverSavedChains = (cwd: string): ChainConfig[] => {
	const chainsByName = new Map<string, ChainConfig>();
	for (const chain of discoverAgentsAll(cwd).chains) {
		chainsByName.set(chain.name, chain);
	}
	return Array.from(chainsByName.values());
};

export const makeChainCompletions = (state: SubagentState) => (prefix: string) => {
	if (prefix.includes(" ") || !state.baseCwd) return null;
	return discoverSavedChains(state.baseCwd)
		.filter((chain) => chain.name.startsWith(prefix))
		.map((chain) => ({ value: chain.name, label: chain.name }));
};

export const makeBuiltinAgentNameCompletions = () => (prefix: string) => {
	if (prefix.includes(" ")) return null;
	return BUILTIN_AGENT_NAMES
		.filter((name) => name.startsWith(prefix))
		.map((name) => ({ value: name, label: name }));
};

export const makeProviderCompletions = (state: SubagentState) => (prefix: string) => {
	if (prefix.includes(" ")) return null;
	const available = state.lastUiContext?.modelRegistry?.getAvailable?.();
	if (!Array.isArray(available)) return null;
	const providers = [...new Set(available
		.map((model) => typeof model?.provider === "string" ? model.provider : "")
		.filter(Boolean))]
		.sort((a, b) => a.localeCompare(b));
	return providers
		.filter((provider) => provider.startsWith(prefix))
		.map((provider) => ({ value: provider, label: provider }));
};
