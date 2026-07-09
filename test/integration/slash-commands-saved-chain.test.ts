import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
	available,
	captureSlashCommandParams,
	clearSlashSnapshots,
	createEventBus,
	createState,
	registerSlashCommands,
	withIsolatedHome,
	withTempProject,
	writeProjectChain,
} from "../support/slash-test-setup.ts";
import type { RegisteredSlashCommand } from "../support/slash-test-setup.ts";
describe("saved chain slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("/run and /chain accept dotted packaged runtime agent names", async () => {
		await withTempProject("pi-packaged-agent-slash-", async (root) => {
			fs.writeFileSync(path.join(root, ".pi", "agents", "code-analysis.scout.md"), `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect
`, "utf-8");
			fs.writeFileSync(path.join(root, ".pi", "agents", "documentation.writer.md"), `---
name: writer
package: documentation
description: Writer
---

Write
`, "utf-8");

			const run = await captureSlashCommandParams("run", "code-analysis.scout Investigate", root);
			assert.deepEqual(run.params, { agent: "code-analysis.scout", task: "Investigate", clarify: false, agentScope: "both" });

			const chain = await captureSlashCommandParams("chain", "code-analysis.scout \"Scan\" -> documentation.writer", root);
			assert.deepEqual((chain.params as { chain?: Array<{ agent?: string; task?: string }> }).chain?.map(({ agent, task }) => ({ agent, task })), [
				{ agent: "code-analysis.scout", task: "Scan" },
				{ agent: "documentation.writer", task: undefined },
			]);

			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};
				registerSlashCommands!(pi, createState(root));
				const runCompletions = commands.get("run")!.getArgumentCompletions!("code-") as Array<{ value: string; label: string }>;
				assert.deepEqual(runCompletions.map((completion) => completion.value), ["code-analysis.scout"]);
				const chainCompletions = commands.get("chain")!.getArgumentCompletions!("code-analysis.scout \"Scan\" -> doc") as Array<{ value: string; label: string }>;
				assert.deepEqual(chainCompletions.map((completion) => completion.value), ["code-analysis.scout \"Scan\" -> documentation.writer"]);
				// Regression: bare group-ish syntax inside a `--` shared task is plain text, not
				// a group separator, so it must not resume agent completion past the task.
				const pipeInTask = commands.get("chain")!.getArgumentCompletions!("code-analysis.scout -- do x | doc");
				assert.equal(pipeInTask, null);
				const openParenInTask = commands.get("chain")!.getArgumentCompletions!("code-analysis.scout -- do (doc");
				assert.equal(openParenInTask, null);
				const closeParenInTask = commands.get("chain")!.getArgumentCompletions!("code-analysis.scout -- do ) doc");
				assert.equal(closeParenInTask, null);
				const balancedParenInTask = commands.get("chain")!.getArgumentCompletions!("code-analysis.scout -- do (x) doc");
				assert.equal(balancedParenInTask, null);
				// Inside an actual parallel group, `|` still separates tasks and completes agents.
				const groupCompletions = commands.get("chain")!.getArgumentCompletions!("code-analysis.scout \"Scan\" -> (documentation.writer \"w\" | code") as Array<{ value: string; label: string }>;
				assert.deepEqual(groupCompletions.map((completion) => completion.value), ["code-analysis.scout \"Scan\" -> (documentation.writer \"w\" | code-analysis.scout"]);
			});
		});
	});

	it("/run-chain launches a saved chain with a shared task", async () => {
		await withTempProject("pi-run-chain-success-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Review flow
---

## scout

Scan {task}

## reviewer

Review {previous}
`);

			const { params } = await captureSlashCommandParams("run-chain", "review-flow -- Audit the auth flow", root);
			const runParams = params as {
				chain?: Array<{ agent?: string; task?: string }>;
				task?: string;
				clarify?: boolean;
				agentScope?: string;
				async?: unknown;
				context?: unknown;
			};

			assert.deepEqual(runParams.chain?.map(({ agent, task }) => ({ agent, task })), [
				{ agent: "scout", task: "Scan {task}" },
				{ agent: "reviewer", task: "Review {previous}" },
			]);
			assert.equal(runParams.task, "Audit the auth flow");
			assert.equal(runParams.clarify, false);
			assert.equal(runParams.agentScope, "both");
			assert.equal(runParams.async, undefined);
			assert.equal(runParams.context, undefined);
		});
	});

	it("/run-chain launches a saved JSON chain with dynamic fanout", async () => {
		await withTempProject("pi-run-chain-json-dynamic-", async (root) => {
			writeProjectChain(root, "dynamic-review.chain.json", JSON.stringify({
				name: "dynamic-review",
				description: "Dynamic review flow",
				chain: [
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
					},
				],
			}));

			const { params } = await captureSlashCommandParams("run-chain", "dynamic-review -- Audit", root);
			const runParams = params as { chain?: Array<Record<string, unknown>>; task?: string; clarify?: boolean; agentScope?: string };

			assert.equal(runParams.task, "Audit");
			assert.equal(runParams.clarify, false);
			assert.equal(runParams.agentScope, "both");
			assert.equal(runParams.chain?.[0]?.agent, "scout");
			assert.deepEqual(runParams.chain?.[1]?.expand, { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 });
			assert.deepEqual(runParams.chain?.[1]?.collect, { as: "reviews" });
		});
	});

	it("/run-chain preserves saved JSON chain acceptance contracts", async () => {
		await withTempProject("pi-run-chain-json-acceptance-", async (root) => {
			writeProjectChain(root, "verified-flow.chain.json", JSON.stringify({
				name: "verified-flow",
				description: "Verified flow",
				chain: [
					{
						agent: "worker",
						task: "Implement fix",
						acceptance: {
							level: "verified",
							verify: [{ id: "tests", command: "npm test" }],
						},
					},
				],
			}));

			const { params } = await captureSlashCommandParams("run-chain", "verified-flow -- Audit", root);
			assert.deepEqual((params as { chain?: Array<{ acceptance?: unknown }> }).chain?.[0]?.acceptance, {
				level: "verified",
				verify: [{ id: "tests", command: "npm test" }],
			});
		});
	});

	it("/run-chain launches and completes packaged saved chains by dotted runtime name", async () => {
		await withTempProject("pi-run-chain-packaged-", async (root) => {
			writeProjectChain(root, "code-analysis.review-flow.chain.md", `---
name: review-flow
package: code-analysis
description: Review flow
---

## code-analysis.scout

Scan {task}
`);

			const { params } = await captureSlashCommandParams("run-chain", "code-analysis.review-flow -- Audit", root);
			assert.equal((params as { task?: string }).task, "Audit");
			assert.deepEqual((params as { chain?: Array<{ agent?: string; task?: string }> }).chain?.map(({ agent, task }) => ({ agent, task })), [
				{ agent: "code-analysis.scout", task: "Scan {task}" },
			]);

			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};
				registerSlashCommands!(pi, createState(root));
				const completions = commands.get("run-chain")!.getArgumentCompletions!("code-") as Array<{ value: string; label: string }>;
				assert.deepEqual(completions.map((completion) => completion.value), ["code-analysis.review-flow"]);
			});
		});
	});

	it("/run-chain reports an unknown saved chain without launching", async () => {
		await withTempProject("pi-run-chain-unknown-", async (root) => {
			const { params, notifications } = await captureSlashCommandParams("run-chain", "missing -- Do work", root);

			assert.equal(params, undefined);
			assert.deepEqual(notifications, ["Unknown chain: missing"]);
		});
	});

	it("/run-chain suggests saved chain names", async () => {
		await withTempProject("pi-run-chain-completions-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Review flow
---

## scout

Scan
`);
			writeProjectChain(root, "release-flow.chain.md", `---
name: release-flow
description: Release flow
---

## planner

Plan
`);
			writeProjectChain(root, "triage.chain.md", `---
name: triage
description: Triage flow
---

## scout

Triage
`);

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

				registerSlashCommands!(pi, createState(root));
				const completions = commands.get("run-chain")!.getArgumentCompletions!("re") as Array<{ value: string; label: string }>;
				assert.deepEqual(completions.map((completion) => completion.value).sort(), ["release-flow", "review-flow"]);
				assert.deepEqual(completions.map((completion) => completion.label).sort(), ["release-flow", "review-flow"]);
				assert.equal(commands.get("run-chain")!.getArgumentCompletions!("review-flow -- "), null);
			});
		});
	});

	it("/run-chain maps --bg to async execution", async () => {
		await withTempProject("pi-run-chain-bg-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Review flow
---

## scout

Scan
`);

			const { params } = await captureSlashCommandParams("run-chain", "review-flow -- Audit --bg", root);

			assert.equal((params as { async?: unknown }).async, true);
			assert.equal((params as { context?: unknown }).context, undefined);
		});
	});

	it("/run-chain maps --fork to forked context", async () => {
		await withTempProject("pi-run-chain-fork-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Review flow
---

## scout

Scan
`);

			const { params } = await captureSlashCommandParams("run-chain", "review-flow -- Audit --fork", root);

			assert.equal((params as { context?: unknown }).context, "fork");
			assert.equal((params as { async?: unknown }).async, undefined);
		});
	});

	it("/run-chain prefers a project saved chain over a same-named user chain", async () => {
		await withTempProject("pi-run-chain-priority-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Project review flow
---

## scout

Project chain task
`);

			const { params } = await captureSlashCommandParams("run-chain", "review-flow -- Shared task", root, () => {
				const userChainsDir = path.join(os.homedir(), ".pi", "agent", "chains");
				fs.mkdirSync(userChainsDir, { recursive: true });
				fs.writeFileSync(path.join(userChainsDir, "review-flow.chain.md"), `---
name: review-flow
description: User review flow
---

## scout

User chain task
`, "utf-8");
			});

			assert.equal((params as { chain?: Array<{ task?: string }> }).chain?.[0]?.task, "Project chain task");
		});
	});

	it("/run-chain resolves saved outputSchema files at the command boundary", async () => {
		await withTempProject("pi-run-chain-schema-", async (root) => {
			const schemasDir = path.join(root, ".pi", "chains", "schemas");
			fs.mkdirSync(schemasDir, { recursive: true });
			fs.writeFileSync(path.join(schemasDir, "finding.schema.json"), JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } } }), "utf-8");
			writeProjectChain(root, "schema-flow.chain.md", `---
name: schema-flow
description: Schema flow
---

## scout
outputSchema: ./schemas/finding.schema.json

Gather context
`);

			const { params } = await captureSlashCommandParams("run-chain", "schema-flow -- Shared task", root);

			assert.deepEqual((params as { chain?: Array<{ outputSchema?: unknown }> }).chain?.[0]?.outputSchema, {
				type: "object",
				properties: { ok: { type: "boolean" } },
			});
		});
	});

	it("/run-chain preserves saved step behavior fields", async () => {
		await withTempProject("pi-run-chain-fields-", async (root) => {
			writeProjectChain(root, "field-flow.chain.md", `---
name: field-flow
description: Field flow
---

## scout
output: context.md
outputMode: file-only
reads: input.md, notes.md
model: openai/gpt-5.5
skills: research, audit
progress: true

Gather context
`);

			const { params } = await captureSlashCommandParams("run-chain", "field-flow -- Shared task", root);

			assert.deepEqual((params as { chain?: unknown[] }).chain?.[0], {
				agent: "scout",
				task: "Gather context",
				output: "context.md",
				outputMode: "file-only",
				reads: ["input.md", "notes.md"],
				progress: true,
				skill: ["research", "audit"],
				model: "openai/gpt-5.5",
			});
		});
	});

	it("/chain parses a parenthesized parallel group into a { parallel: [...] } step", async () => {
		await withTempProject("pi-chain-group-slash-", async (root) => {
			for (const name of ["scout", "reviewer", "writer"]) {
				fs.writeFileSync(path.join(root, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\n\nBody\n`, "utf-8");
			}

			const { params, notifications } = await captureSlashCommandParams("chain", 'scout "scan" -> (reviewer "A" | reviewer "B") -> writer "fix"', root);
			assert.deepEqual(notifications, []);
			const built = params as { chain?: Array<Record<string, unknown>>; task?: string };
			assert.equal(built.task, "scan");
			assert.equal(built.chain?.length, 3);
			assert.equal(built.chain?.[0]?.agent, "scout");
			const parallel = built.chain?.[1]?.parallel as Array<{ agent: string; task: string }>;
			assert.ok(Array.isArray(parallel), "second step should be a parallel group");
			assert.deepEqual(parallel.map(({ agent, task }) => ({ agent, task })), [
				{ agent: "reviewer", task: "A" },
				{ agent: "reviewer", task: "B" },
			]);
			assert.equal(built.chain?.[2]?.agent, "writer");
		});
	});

	it("/chain reports parallel-group errors as notifications and does not launch", async () => {
		await withTempProject("pi-chain-group-error-", async (root) => {
			for (const name of ["scout", "reviewer"]) {
				fs.writeFileSync(path.join(root, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\n\nBody\n`, "utf-8");
			}

			const { params, notifications } = await captureSlashCommandParams("chain", 'scout "scan" -> (reviewer "A")', root);
			assert.equal(params, undefined);
			assert.equal(notifications.length, 1);
			assert.match(notifications[0] ?? "", /at least two/i);
		});
	});

	it("/chain carries inline metadata and group options through to params", async () => {
		await withTempProject("pi-chain-group-meta-", async (root) => {
			for (const name of ["scout", "reviewer", "writer"]) {
				fs.writeFileSync(path.join(root, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\n\nBody\n`, "utf-8");
			}

			const { params, notifications } = await captureSlashCommandParams(
				"chain",
				'scout[as=ctx,phase=recon] "scan" -> (reviewer "A" | writer "B")[concurrency=2,failFast]',
				root,
			);
			assert.deepEqual(notifications, []);
			const built = params as { chain?: Array<Record<string, unknown>> };
			assert.equal(built.chain?.[0]?.as, "ctx");
			assert.equal(built.chain?.[0]?.phase, "recon");
			const group = built.chain?.[1] as Record<string, unknown>;
			assert.equal((group.parallel as unknown[]).length, 2);
			assert.equal(group.concurrency, 2);
			assert.equal(group.failFast, true);
		});
	});

	it("/chain tab-completion works inside parallel groups", async () => {
		await withTempProject("pi-chain-group-complete-", async (root) => {
			for (const name of ["scout", "reviewer", "writer"]) {
				fs.writeFileSync(path.join(root, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\n\nBody\n`, "utf-8");
			}
			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};
				registerSlashCommands!(pi, createState(root));
				const complete = (prefix: string) =>
					(commands.get("chain")!.getArgumentCompletions!(prefix) as Array<{ value: string }> | null)?.map((c) => c.value) ?? null;

				// after `(`
				assert.deepEqual(complete('scout "scan" -> (rev'), ['scout "scan" -> (reviewer']);
				// after `|`
				assert.deepEqual(complete('scout "scan" -> (reviewer "A" | wr'), ['scout "scan" -> (reviewer "A" | writer']);
				// after a bare `|` a space is inserted before every suggested agent
				const barePipe = complete('scout "scan" -> (reviewer "A" |');
				assert.ok(barePipe && barePipe.length > 0);
				assert.ok(barePipe.every((v) => v.startsWith('scout "scan" -> (reviewer "A" | ')));
				assert.ok(barePipe.includes('scout "scan" -> (reviewer "A" | writer'));
				// inside an open quote: no agent completion
				assert.equal(complete('scout "scan'), null);
			});
		});
	});
});
