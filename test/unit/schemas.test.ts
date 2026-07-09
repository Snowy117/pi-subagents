import assert from "node:assert/strict";
import { describe, it } from "node:test";

type JsonSchemaNode = Record<string, unknown>;

interface SubagentParamsSchema {
	properties?: {
		context?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		tasks?: {
			items?: {
				properties?: {
					count?: {
						minimum?: number;
						description?: string;
					};
				};
			};
		};
		concurrency?: {
			minimum?: number;
			description?: string;
		};
		timeoutMs?: {
			minimum?: number;
			description?: string;
		};
		maxRuntimeMs?: {
			minimum?: number;
			description?: string;
		};
		turnBudget?: {
			properties?: {
				maxTurns?: { minimum?: number };
				graceTurns?: { minimum?: number };
			};
		};
		id?: {
			type?: string;
			description?: string;
		};
		runId?: {
			type?: string;
			description?: string;
		};
		dir?: {
			type?: string;
			description?: string;
		};
		action?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		view?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		lines?: {
			minimum?: number;
			maximum?: number;
			description?: string;
		};
		control?: {
			properties?: {
				needsAttentionAfterMs?: { minimum?: number };
				activeNoticeAfterMs?: { minimum?: number };
				activeNoticeAfterTurns?: { minimum?: number };
				activeNoticeAfterTokens?: { minimum?: number };
				failedToolAttemptsBeforeAttention?: { minimum?: number };
				notifyOn?: { items?: { enum?: string[] } };
				notifyChannels?: { items?: { enum?: string[] } };
			};
		};
		skill?: JsonSchemaNode;
		output?: JsonSchemaNode;
		config?: JsonSchemaNode;
		chain?: {
			items?: JsonSchemaNode & {
				properties?: Record<string, JsonSchemaNode>;
			};
		};
	};
}

function missingPackageName(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	return message.match(/Cannot find package ['"]([^'"]+)['"]/i)?.[1];
}

function anyOfBranches(schema: JsonSchemaNode | undefined): JsonSchemaNode[] {
	const anyOf = schema?.anyOf;
	if (!Array.isArray(anyOf)) return [];
	return anyOf.filter((branch): branch is JsonSchemaNode => !!branch && typeof branch === "object");
}

function hasAnyOfType(schema: JsonSchemaNode | undefined, type: string): boolean {
	return anyOfBranches(schema).some((branch) => branch.type === type);
}

function hasAnyOfArrayWithStringItems(schema: JsonSchemaNode | undefined): boolean {
	return anyOfBranches(schema).some((branch) => {
		if (branch.type !== "array") return false;
		const items = branch.items;
		return !!items && typeof items === "object" && (items as JsonSchemaNode).type === "string";
	});
}

function getPropertySchema(schema: JsonSchemaNode | undefined, path: string[]): JsonSchemaNode | undefined {
	let current: unknown = schema;
	for (const key of path) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as JsonSchemaNode).properties;
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current && typeof current === "object" ? current as JsonSchemaNode : undefined;
}

let schemas: Record<string, JsonSchemaNode> = {};
let SubagentParams: SubagentParamsSchema | undefined;
let schemasAvailable = true;
try {
	schemas = await import("../../src/extension/schemas.ts") as Record<string, JsonSchemaNode>;
	SubagentParams = schemas.SubagentParams as SubagentParamsSchema;
} catch (error) {
	if (missingPackageName(error) !== "typebox") throw error;
	schemasAvailable = false;
}
let CompileSchema: ((schema: unknown) => { Check(value: unknown): boolean; Errors(value: unknown): Iterable<{ message: string }> }) | undefined;
try {
	const compileModule = await import("typebox/compile") as { Compile: typeof CompileSchema };
	CompileSchema = compileModule.Compile;
} catch (error) {
	if (missingPackageName(error) !== "typebox") throw error;
	// The structural schema assertions below do not need the optional compiler package.
}

describe("SubagentParams schema", () => {
	it("includes context field for fresh/fork execution mode", () => {
		const contextSchema = SubagentParams?.properties?.context;
		assert.ok(contextSchema, "context schema should exist");
		assert.equal(contextSchema.type, "string");
		assert.deepEqual(contextSchema.enum, ["fresh", "fork"]);
		const description = String(contextSchema.description ?? "");
		assert.match(description, /fresh/);
		assert.match(description, /fork/);
		assert.match(description, /each requested agent/);
		assert.match(description, /overrides every child/);
	});

	it("includes count and concurrency on top-level parallel mode", () => {
		const taskSchema = SubagentParams?.properties?.tasks?.items?.properties;
		const taskCountSchema = taskSchema?.count;
		assert.ok(taskCountSchema, "tasks[].count schema should exist");
		assert.equal(taskCountSchema.minimum, 1);
		const outputSchema = taskSchema?.output as JsonSchemaNode | undefined;
		assert.equal(outputSchema?.type, undefined);
		assert.equal(hasAnyOfType(outputSchema, "string"), true);
		assert.equal(hasAnyOfType(outputSchema, "boolean"), true);
		const readsSchema = taskSchema?.reads as JsonSchemaNode | undefined;
		assert.equal(readsSchema?.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(readsSchema), true);
		assert.equal(hasAnyOfType(readsSchema, "boolean"), true);
		assert.equal(taskSchema?.progress?.type, "boolean");

		const concurrencySchema = SubagentParams?.properties?.concurrency;
		assert.ok(concurrencySchema, "concurrency schema should exist");
		assert.equal(concurrencySchema.minimum, 1);
		assert.match(String(concurrencySchema.description ?? ""), /parallel/i);
	});

	it("allows runtime validation of management and control action strings", () => {
		const actionSchema = SubagentParams?.properties?.action;
		assert.ok(actionSchema, "action schema should exist");
		assert.equal(actionSchema.type, "string");
		assert.equal(actionSchema.enum, undefined);
		const description = String(actionSchema.description ?? "");
		assert.match(description, /Management\/control action only/);
		assert.match(description, /Must be omitted for execution mode/);
		assert.match(description, /single, parallel, or chain/);
		assert.doesNotMatch(description, /orchestration\./);
	});

	it("includes foreground timeout aliases and turn budget", () => {
		const timeoutSchema = SubagentParams?.properties?.timeoutMs;
		const maxRuntimeSchema = SubagentParams?.properties?.maxRuntimeMs;
		const turnBudgetSchema = SubagentParams?.properties?.turnBudget;
		const toolBudgetSchema = SubagentParams?.properties?.toolBudget;
		assert.ok(timeoutSchema, "timeoutMs schema should exist");
		assert.ok(maxRuntimeSchema, "maxRuntimeMs schema should exist");
		assert.equal(timeoutSchema.minimum, 1);
		assert.equal(maxRuntimeSchema.minimum, 1);
		assert.match(String(timeoutSchema.description ?? ""), /foreground and async\/background/i);
		assert.doesNotMatch(String(timeoutSchema.description ?? ""), /foreground-only/i);
		assert.match(String(maxRuntimeSchema.description ?? ""), /timeoutMs/i);
		assert.match(String(maxRuntimeSchema.description ?? ""), /foreground and async\/background/i);
		assert.equal(turnBudgetSchema?.properties?.maxTurns?.minimum, 1);
		assert.equal(turnBudgetSchema?.properties?.graceTurns?.minimum, 0);
		assert.equal(toolBudgetSchema?.properties?.soft?.minimum, 1);
		assert.equal(toolBudgetSchema?.properties?.hard?.minimum, 1);
	});

	it("includes subagent control fields", () => {
		const idSchema = SubagentParams?.properties?.id;
		assert.ok(idSchema, "id schema should exist");
		assert.equal(idSchema.type, "string");
		assert.match(String(idSchema.description ?? ""), /status/i);
		assert.match(String(idSchema.description ?? ""), /interrupt/i);
		assert.match(String(idSchema.description ?? ""), /steer/i);
		assert.match(String(idSchema.description ?? ""), /append-step/i);

		const runIdSchema = SubagentParams?.properties?.runId;
		assert.ok(runIdSchema, "runId schema should exist");
		assert.equal(runIdSchema.type, "string");
		assert.match(String(runIdSchema.description ?? ""), /interrupt/i);
		assert.match(String(runIdSchema.description ?? ""), /steer/i);
		assert.match(String(runIdSchema.description ?? ""), /append-step/i);

		const dirSchema = SubagentParams?.properties?.dir;
		assert.ok(dirSchema, "dir schema should exist");
		assert.equal(dirSchema.type, "string");
		assert.match(String(dirSchema.description ?? ""), /status/i);
		assert.match(String(dirSchema.description ?? ""), /steer/i);

		const viewSchema = SubagentParams?.properties?.view;
		assert.ok(viewSchema, "view schema should exist");
		assert.equal(viewSchema.type, "string");
		assert.deepEqual(viewSchema.enum, ["fleet", "transcript"]);
		assert.match(String(viewSchema.description ?? ""), /status view/i);
		assert.match(String(viewSchema.description ?? ""), /transcript/i);

		const linesSchema = SubagentParams?.properties?.lines;
		assert.ok(linesSchema, "lines schema should exist");
		assert.equal(linesSchema.minimum, 1);
		assert.equal(linesSchema.maximum, 500);
		assert.match(String(linesSchema.description ?? ""), /transcript/i);

		const controlSchema = SubagentParams?.properties?.control;
		assert.ok(controlSchema, "control schema should exist");
		assert.equal(controlSchema.properties?.needsAttentionAfterMs?.minimum, 1);
		assert.equal(controlSchema.properties?.activeNoticeAfterMs?.minimum, 1);
		assert.equal(controlSchema.properties?.activeNoticeAfterTurns?.minimum, 1);
		assert.equal(controlSchema.properties?.activeNoticeAfterTokens?.minimum, 1);
		assert.equal(controlSchema.properties?.failedToolAttemptsBeforeAttention?.minimum, 1);
		assert.deepEqual(controlSchema.properties?.notifyOn?.items?.enum, ["active_long_running", "needs_attention"]);
		assert.deepEqual(controlSchema.properties?.notifyChannels?.items?.enum, ["event", "async", "intercom"]);
	});

	it("does not emit description-only schema nodes", () => {
		const descriptionOnlyPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (Object.hasOwn(node, "description") && !Object.hasOwn(node, "type") && !Object.hasOwn(node, "anyOf")) {
					descriptionOnlyPaths.push(current.path);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(descriptionOnlyPaths, []);
	});

});
