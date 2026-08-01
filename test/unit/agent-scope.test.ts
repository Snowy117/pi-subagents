import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveExecutionAgentScope } from "../../src/agents/agent-scope.ts";

describe("resolveExecutionAgentScope", () => {
	it("always returns both", () => {
		assert.equal(resolveExecutionAgentScope(), "both");
	});
});
