import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
	available,
	captureSlashCommandParams,
	clearSlashSnapshots,
	createCommandContext,
	createEventBus,
	createState,
	registerSlashCommands,
	SLASH_RESULT_TYPE,
	withIsolatedHome,
} from "../support/slash-test-setup.ts";
import type { RegisteredSlashCommand } from "../support/slash-test-setup.ts";
describe("subagents-models slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("routes to the models tool action", async () => {
		const { params } = await captureSlashCommandParams("subagents-models", "", process.cwd());
		assert.deepEqual(params, { action: "models" });
	});

	it("passes an optional builtin filter", async () => {
		const { params } = await captureSlashCommandParams("subagents-models", "scout", process.cwd());
		assert.deepEqual(params, { action: "models", agent: "scout" });
	});

	it("rejects invalid builtin filters without launching", async () => {
		const { params, notifications } = await captureSlashCommandParams("subagents-models", "not-a-builtin", process.cwd());
		assert.equal(params, undefined);
		assert.deepEqual(notifications, ["Unknown builtin agent: not-a-builtin"]);
	});

	it("suggests builtin agent names", async () => {
		await withIsolatedHome(async () => {
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) {
					commands.set(name, spec);
				},
				registerShortcut() {},
				sendMessage(_message: unknown) {},
			};

			registerSlashCommands!(pi, createState(process.cwd()));
			const completions = commands.get("subagents-models")!.getArgumentCompletions!("sc") as Array<{ value: string; label: string }>;
			assert.deepEqual(completions.map((completion) => completion.value), ["scout"]);
		});
	});
});

describe("subagent cost slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	it("reports parent and child usage from the current session branch", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, RegisteredSlashCommand>();
		const pi = {
			events: createEventBus(),
			registerCommand(name: string, spec: RegisteredSlashCommand) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) { sent.push(message); },
		};
		const parentUsage = {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		};
		const childUsage = { input: 20, output: 10, cacheRead: 2, cacheWrite: 1, cost: 0.004, turns: 1 };
		const slashChildUsage = { input: 30, output: 15, cacheRead: 0, cacheWrite: 0, cost: 0.005, turns: 2 };
		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("subagent-cost")!.handler("", createCommandContext({
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "assistant", usage: parentUsage } },
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "subagent",
							details: {
								mode: "single",
								results: [{ agent: "worker", task: "fix", exitCode: 0, messages: [], usage: childUsage, sessionFile: "/tmp/worker.jsonl" }],
							},
						},
					},
					{
						type: "custom_message",
						customType: SLASH_RESULT_TYPE,
						details: {
							requestId: "slash-1",
							result: {
								content: [{ type: "text", text: "done" }],
								details: {
									mode: "single",
									results: [{ agent: "reviewer", task: "review", exitCode: 0, messages: [], usage: slashChildUsage }],
								},
							},
						},
					},
				],
			},
		}));

		const output = String((sent[0] as { content?: unknown }).content ?? "");
		assert.match(output, /Parent: ↑100 ↓50 \$0\.0030/);
		assert.match(output, /Child 1 \(worker\): ↑20 ↓10 \$0\.0040/);
		assert.match(output, /Session: \/tmp\/worker\.jsonl/);
		assert.match(output, /Child 2 \(reviewer\): ↑30 ↓15 \$0\.0050/);
		assert.match(output, /Children: ↑50 ↓25 \$0\.0090/);
		assert.match(output, /Total: ↑150 ↓75 \$0\.0120/);
	});
});

describe("subagent profiles slash commands", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	it("lists saved profiles", async () => {
		await withIsolatedHome(async () => {
			const profilesDir = path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents");
			fs.mkdirSync(profilesDir, { recursive: true });
			fs.writeFileSync(path.join(profilesDir, "openai-codex.quota.json"), JSON.stringify({ subagents: { agentOverrides: {} } }));
			fs.writeFileSync(path.join(profilesDir, "openai-codex.quality.json"), JSON.stringify({ subagents: { agentOverrides: {} } }));
			const sent: unknown[] = [];
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) {
					commands.set(name, spec);
				},
				registerShortcut() {},
				sendMessage(message: unknown) { sent.push(message); },
			};
			registerSlashCommands!(pi, createState(process.cwd()));
			await commands.get("subagents-profiles")!.handler("", createCommandContext());
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /openai-codex\.quota/);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /openai-codex\.quality/);
		});
	});

	it("loads a saved profile into user settings", async () => {
		await withIsolatedHome(async () => {
			const profilesDir = path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents");
			fs.mkdirSync(profilesDir, { recursive: true });
			fs.writeFileSync(path.join(profilesDir, "openai-codex.quota.json"), JSON.stringify({
				subagents: { agentOverrides: {
					scout: { model: "openai-codex/gpt-5.3-codex-spark" },
					worker: { model: "openai-codex/gpt-5.4" },
				} },
			}, null, 2));
			const sent: unknown[] = [];
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage(message: unknown) { sent.push(message); },
			};
			registerSlashCommands!(pi, createState(process.cwd()));
			await commands.get("subagents-load-profile")!.handler("openai-codex.quota", createCommandContext());
			const settings = JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".pi", "agent", "settings.json"), "utf-8"));
			assert.equal(settings.subagents.agentOverrides.scout.model, "openai-codex/gpt-5.3-codex-spark");
			assert.equal(settings.subagents.agentOverrides.worker.model, "openai-codex/gpt-5.4");
			assert.doesNotMatch(String((sent[0] as { content?: unknown }).content ?? ""), /run \/reload/);
		});
	});

	it("can switch the current session model to the loaded profile worker model", async () => {
		await withIsolatedHome(async () => {
			const profilesDir = path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents");
			fs.mkdirSync(profilesDir, { recursive: true });
			fs.writeFileSync(path.join(profilesDir, "openai-codex.quota.json"), JSON.stringify({
				subagents: { agentOverrides: { worker: { model: "gpt-5.4:high" } } },
			}, null, 2));
			const sent: unknown[] = [];
			const commands = new Map<string, RegisteredSlashCommand>();
			let setModelArg: unknown;
			const resolvedModel = { provider: "openai-codex", id: "gpt-5.4" };
			const pi = {
				events: createEventBus(),
				async setModel(model: unknown) { setModelArg = model; return true; },
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage(message: unknown) { sent.push(message); },
			};
			registerSlashCommands!(pi as never, createState(process.cwd()));
			await commands.get("subagents-load-profile")!.handler("openai-codex.quota", createCommandContext({
				confirm: async () => true,
				modelRegistry: {
					getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.4" }],
					find: (provider, id) => provider === "openai-codex" && id === "gpt-5.4" ? resolvedModel : undefined,
				},
			}) as never);
			assert.equal(setModelArg, resolvedModel);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /Current session model switched to: openai-codex\/gpt-5.4/);
		});
	});

	it("refreshes a provider model catalog", async () => {
		await withIsolatedHome(async () => {
			const sent: unknown[] = [];
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				exec: async () => ({ stdout: "OK\n", stderr: "", code: 0, killed: false }),
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage(message: unknown) { sent.push(message); },
			};
			registerSlashCommands!(pi, createState(process.cwd()));
			await commands.get("subagents-refresh-provider-models")!.handler("openai-codex", createCommandContext({
				cwd: process.cwd(),
				modelRegistry: {
					getAvailable: () => [
						{ provider: "openai-codex", id: "gpt-5.3-codex-spark", reasoning: true },
						{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true },
					],
				},
			}) as never);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /Provider: openai-codex/);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /Warning: 2 models were classified with name heuristics fallback\./);
			assert.equal(fs.existsSync(path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents", "providers", "openai-codex.models.json")), true);
		});
	});

	it("generates provider profiles", async () => {
		await withIsolatedHome(async () => {
			const sent: unknown[] = [];
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				exec: async () => ({ stdout: "OK\n", stderr: "", code: 0, killed: false }),
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage(message: unknown) { sent.push(message); },
			};
			registerSlashCommands!(pi, createState(process.cwd()));
			await commands.get("subagents-generate-profiles")!.handler("openai-codex", createCommandContext({
				modelRegistry: {
					getAvailable: () => [
						{ provider: "openai-codex", id: "gpt-5.3-codex-spark", reasoning: true },
						{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true },
						{ provider: "openai-codex", id: "gpt-5.4", reasoning: true },
						{ provider: "openai-codex", id: "gpt-5.5", reasoning: true },
					],
				},
			}) as never);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /Generated subagent profiles/);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /Warning: generated profiles depend on heuristic-only classification for 4 selected models\./);
			assert.equal(fs.existsSync(path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents", "openai-codex.quota.json")), true);
			assert.equal(fs.existsSync(path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents", "openai-codex.quality.json")), true);
		});
	});

	it("checks a profile", async () => {
		await withIsolatedHome(async () => {
			const profilesDir = path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents");
			fs.mkdirSync(profilesDir, { recursive: true });
			fs.writeFileSync(path.join(profilesDir, "demo.json"), JSON.stringify({
				subagents: { agentOverrides: { scout: { model: "openai-codex/gpt-5.3-codex-spark" } } },
			}, null, 2));
			const sent: unknown[] = [];
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				exec: async () => ({ stdout: "OK\n", stderr: "", code: 0, killed: false }),
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage(message: unknown) { sent.push(message); },
			};
			registerSlashCommands!(pi, createState(process.cwd()));
			await commands.get("subagents-check-profile")!.handler("demo", createCommandContext({
				modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.3-codex-spark" }] },
			}) as never);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /probe ok/);
		});
	});

	it("suggests provider names for refresh and generate commands", async () => {
		await withIsolatedHome(async () => {
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage(_message: unknown) {},
			};
			const state = createState(process.cwd());
			state.lastUiContext = createCommandContext({
				modelRegistry: {
					getAvailable: () => [
						{ provider: "openai-codex", id: "gpt-5.4" },
						{ provider: "openai", id: "gpt-5" },
						{ provider: "anthropic", id: "claude-sonnet-4" },
					],
				},
			}) as never;
			registerSlashCommands!(pi, state);
			const refresh = commands.get("subagents-refresh-provider-models")!.getArgumentCompletions!("open") as Array<{ value: string; label: string }>;
			const generate = commands.get("subagents-generate-profiles")!.getArgumentCompletions!("an") as Array<{ value: string; label: string }>;
			assert.deepEqual(refresh.map((entry) => entry.value), ["openai", "openai-codex"]);
			assert.deepEqual(generate.map((entry) => entry.value), ["anthropic"]);
		});
	});
});

describe("subagents-doctor slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("routes to the doctor tool action", async () => {
		const { params } = await captureSlashCommandParams("subagents-doctor", "", process.cwd());
		assert.deepEqual(params, { action: "doctor" });
	});

	it("routes fleet to the read-only status view", async () => {
		const { params } = await captureSlashCommandParams("subagents-fleet", "", process.cwd());
		assert.deepEqual(params, { action: "status", view: "fleet" });
	});

	it("does not register the removed subagents-status overlay command", async () => {
		await withIsolatedHome(async () => {
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) {
					commands.set(name, spec);
				},
				registerShortcut() {},
				sendMessage(_message: unknown) {},
			};

			registerSlashCommands!(pi, createState(process.cwd()));
			assert.equal(commands.has("subagents-status"), false);
		});
	});

});
