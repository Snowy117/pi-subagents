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
	it("does not emit array-typed schema nodes without items", () => {
		const missingItemsPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (node.type === "array" && !Object.hasOwn(node, "items")) {
					missingItemsPaths.push(current.path);
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

		assert.deepEqual(missingItemsPaths, []);
	});

	it("keeps only top-level parameter descriptions to keep the provider payload compact", () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		const schema = SubagentParams as unknown as JsonSchemaNode;
		const serialized = JSON.stringify(schema);
		assert.ok(serialized.length < 15_000, `expected compact schema under 15k chars, got ${serialized.length}`);
		assert.equal(serialized.includes('"$ref"'), false);
		assert.equal(serialized.includes('"$defs"'), false);
		assert.equal(serialized.split("Optional acceptance policy.").length - 1, 0);
		assert.equal(String((schema.properties as Record<string, JsonSchemaNode> | undefined)?.agent?.description ?? ""), "");
		assert.equal(String((schema.properties as Record<string, JsonSchemaNode> | undefined)?.acceptance?.description ?? ""), "");

		const nestedDescriptionPaths: string[] = [];
		const stack: Array<{ path: string; value: unknown }> = [{ path: "SubagentParams", value: schema }];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (!current.value || typeof current.value !== "object") continue;
			const node = current.value as JsonSchemaNode;
			const pathParts = current.path.split(".");
			const isTopLevelParameter = pathParts.length === 3 && pathParts[0] === "SubagentParams" && pathParts[1] === "properties";
			if (typeof node.description === "string" && !isTopLevelParameter) nestedDescriptionPaths.push(`${current.path}.description`);
			if (Array.isArray(current.value)) {
				current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
			} else {
				for (const [key, value] of Object.entries(node)) stack.push({ path: `${current.path}.${key}`, value });
			}
		}
		assert.deepEqual(nestedDescriptionPaths, []);
	});

	it("preserves TypeBox metadata while pruning provider-visible descriptions", () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		const schema = SubagentParams as unknown as JsonSchemaNode;
		const rootKind = Object.getOwnPropertyDescriptor(schema, "~kind");
		assert.equal(rootKind?.value, "Object");
		assert.equal(rootKind?.enumerable, false);

		const tasksSchema = getPropertySchema(schema, ["tasks"]);
		const taskItemsSchema = tasksSchema?.items as JsonSchemaNode | undefined;
		const taskCountSchema = getPropertySchema(taskItemsSchema, ["count"]);
		assert.equal(Object.getOwnPropertyDescriptor(taskCountSchema, "~kind")?.enumerable, false);
		assert.equal(Object.getOwnPropertyDescriptor(taskCountSchema, "~optional")?.value, true);
		assert.equal(Object.getOwnPropertyDescriptor(taskCountSchema, "~optional")?.enumerable, false);
	});

	it("does not emit provider-rejected schema shapes", () => {
		const rejectedPaths: string[] = [];
		const rejectedKeywords = ["allOf", "const", "if", "then", "not"];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (Array.isArray(node.type)) {
					rejectedPaths.push(`${current.path}.type`);
				}
				if (Object.hasOwn(node, "anyOf") && Object.hasOwn(node, "type")) {
					rejectedPaths.push(`${current.path}.type+anyOf`);
				}
				for (const keyword of rejectedKeywords) {
					if (Object.hasOwn(node, keyword)) rejectedPaths.push(`${current.path}.${keyword}`);
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

		assert.deepEqual(rejectedPaths, []);
	});

	it("uses provider-friendly anyOf unions for flexible fields", () => {
		const configSchema = SubagentParams?.properties?.config;
		assert.ok(configSchema, "config schema should exist");
		assert.equal(configSchema.type, undefined);
		assert.equal(anyOfBranches(configSchema).some((branch) => branch.type === "object" && branch.additionalProperties === true), true);
		assert.equal(hasAnyOfType(configSchema, "string"), true);
	});

	it("validates representative flexible field values with TypeBox compiler", { skip: !CompileSchema ? "typebox compiler not available" : undefined }, () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		assert.ok(CompileSchema, "TypeBox compiler should exist");
		const validator = CompileSchema(SubagentParams);
		const validValues = [
			{ tasks: [{ agent: "reviewer", task: "check this", progress: true }] },
			{ action: "steer", id: "run-1", message: "focus on tests" },
			{ action: "steer", id: "run-1", index: 0, message: "focus on tests" },
			{ action: "list" },
			{ action: "status", id: "run-1" },
			{ tasks: [{ agent: "worker", task: "Fix" }] },
			{ config: { name: "reviewer", description: "Review things" } },
			{ config: JSON.stringify({ name: "reviewer", description: "Review things" }) },
			{ action: "not-a-real-action" },
			{ context: "fresh" },
			{ context: "fork" },
			{ async: true },
			{ artifacts: true },
			{ includeProgress: true },
			{ worktree: true },
			{ concurrency: 2 },
			{ schedule: "+10m" },
			{ scheduleName: "my-schedule" },
			{ view: "fleet" },
			{ view: "transcript" },
			{ lines: 50 },
		];
		const invalidValues = [
			{ config: [] },
			{ config: null },
			{ concurrency: 0 },
			{ lines: 0 },
			{ lines: 501 },
			{ view: "invalid" },
			{ context: "invalid" },
		];

		for (const value of validValues) {
			assert.doesNotThrow(() => validator.Check(value), `validator should not throw for ${JSON.stringify(value)}`);
			assert.equal(
				validator.Check(value),
				true,
				`${JSON.stringify(value)} should validate: ${[...validator.Errors(value)].map((error) => error.message).join(", ")}`,
			);
		}
		for (const value of invalidValues) {
			assert.equal(validator.Check(value), false, `${JSON.stringify(value)} should not validate`);
		}
	});
});
