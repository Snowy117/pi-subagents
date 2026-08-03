import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCompletionBroker } from "../../src/runs/background/completion-broker.ts";

describe("completion broker", () => {
	it("returns a completion cached before wait subscription", async () => {
		const broker = createCompletionBroker({ now: () => 10 });
		broker.cache({ runId: "r", sessionId: "s", mode: "single", data: { success: true } });
		assert.equal((await broker.wait("r"))?.runId, "r");
	});
	it("tracks and releases synchronous ownership", () => {
		const broker = createCompletionBroker({ now: () => 10 });
		broker.claim({ runId: "r", sessionId: "s", mode: "single", tasks: [{ agent: "delegate", task: "do" }] });
		assert.equal(broker.isOwned("r", "s"), true);
		broker.release("r");
		assert.equal(broker.isOwned("r"), false);
	});
	it("prunes by session, size, and ttl", () => {
		let now = 0;
		const broker = createCompletionBroker({ now: () => now, ttlMs: 10, maxEntries: 1 });
		broker.cache({ runId: "a", sessionId: "old", mode: "single", data: {} });
		broker.cache({ runId: "b", sessionId: "new", mode: "single", data: {} });
		assert.equal(broker.get("a"), undefined);
		broker.resetSession("new");
		assert.ok(broker.get("b"));
		now = 20;
		assert.equal(broker.get("b"), undefined);
	});
	it("expires synchronous ownership with the broker ttl", () => {
		let now = 0;
		const broker = createCompletionBroker({ now: () => now, ttlMs: 10 });
		broker.claim({ runId: "r", sessionId: "s", mode: "single", tasks: [{ agent: "delegate", task: "do" }] });
		now = 20;
		assert.equal(broker.isOwned("r", "s"), false);
	});
	it("bounds synchronous ownership and removes foreign ownership on session reset", () => {
		const broker = createCompletionBroker({ now: () => 0, maxEntries: 1 });
		broker.claim({ runId: "old", sessionId: "old-session", mode: "single", tasks: [] });
		broker.claim({ runId: "new", sessionId: "new-session", mode: "single", tasks: [] });
		assert.equal(broker.isOwned("old"), false);
		assert.equal(broker.isOwned("new", "new-session"), true);
		broker.resetSession("other-session");
		assert.equal(broker.isOwned("new"), false);
	});
	it("clears ownership and resolves waiters when disposed", async () => {
		const broker = createCompletionBroker();
		broker.claim({ runId: "r", sessionId: "s", mode: "single", tasks: [] });
		const pending = broker.wait("r");
		broker.dispose();
		assert.equal(broker.isOwned("r"), false);
		assert.equal(await pending, undefined);
	});
	it("aborts only the waiter", async () => {
		const broker = createCompletionBroker();
		const controller = new AbortController();
		const pending = broker.wait("r", controller.signal);
		controller.abort();
		assert.equal(await pending, undefined);
	});
});
