import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function createState(): SubagentState {
	return {
		baseCwd: "/repo",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

describe("result watcher nested registry enrichment and completion", () => {
	it("enriches async completion and intercom payloads with nested registry children before deletion", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-"));
		const route = createNestedRoute("async-nested-root");
		try {
			writeNestedEvent(route, {
				type: "subagent.nested.completed",
				ts: Date.now(),
				parentRunId: "async-nested-root",
				parentStepIndex: 0,
				child: {
					id: "nested-child",
					parentRunId: "async-nested-root",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "async-nested-root", stepIndex: 0 }],
					state: "complete",
					agent: "nested-reviewer",
					sessionFile: path.join(resultsDir, "nested-child.jsonl"),
				},
			});
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const resultPath = path.join(resultsDir, "async-nested-root.json");
			try {
				fs.writeFileSync(resultPath, JSON.stringify({
					id: "async-nested-root",
					runId: "async-nested-root",
					agent: "owner",
					mode: "single",
					success: true,
					state: "complete",
					summary: "owner done",
					results: [{ agent: "owner", output: "owner done", success: true }],
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(resultPath), false);
			const intercomPayload = emitted.find((entry) => entry.event === "subagent:result-intercom")?.data as { children?: Array<{ children?: Array<{ id?: string; controlInbox?: string; capabilityToken?: string }> }>; message?: string } | undefined;
			assert.equal(intercomPayload?.children?.[0]?.children?.[0]?.id, "nested-child");
			assert.equal(intercomPayload?.children?.[0]?.children?.[0]?.controlInbox, undefined);
			assert.equal(intercomPayload?.children?.[0]?.children?.[0]?.capabilityToken, undefined);
			assert.match(String(intercomPayload?.message ?? ""), /Nested subagents:/);
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { nestedChildren?: Array<{ id?: string }>; results?: Array<{ children?: Array<{ id?: string }> }> } | undefined;
			assert.equal(completion?.nestedChildren?.[0]?.id, "nested-child");
			assert.equal(completion?.results?.[0]?.children?.[0]?.id, "nested-child");
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("filters malformed explicit nested children in result files before compacting", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-malformed-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const resultPath = path.join(resultsDir, "async-explicit-nested.json");
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				fs.writeFileSync(resultPath, JSON.stringify({
					id: "async-explicit-nested",
					runId: "async-explicit-nested",
					agent: "owner",
					mode: "single",
					success: true,
					state: "complete",
					summary: "owner done",
					results: [{
						agent: "owner",
						output: "owner done",
						success: true,
						children: [
							{ id: "child-explicit-good", parentRunId: "async-explicit-nested", depth: 1, path: [{ runId: "async-explicit-nested" }], state: "complete", agent: "child-good" },
							{ id: "child-explicit-bad", path: "not-an-array" },
						],
					}],
					nestedChildren: [
						{ id: "top-explicit-good", parentRunId: "async-explicit-nested", parentStepIndex: 0, depth: 1, path: [{ runId: "async-explicit-nested", stepIndex: 0 }], state: "complete", agent: "top-good" },
						{ id: "top-explicit-bad", path: "not-an-array" },
					],
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(resultPath), false);
			assert.ok(logged.some((entry) => String(entry[0] ?? "").includes(resultPath) && /invalid nested child record/.test(String(entry[0] ?? ""))));
			const intercomPayload = emitted.find((entry) => entry.event === "subagent:result-intercom")?.data as { children?: Array<{ children?: Array<{ id?: string }> }> } | undefined;
			const intercomNestedIds = intercomPayload?.children?.[0]?.children?.map((child) => child.id) ?? [];
			assert.deepEqual(intercomNestedIds.sort(), ["child-explicit-good", "top-explicit-good"].sort());
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { results?: Array<{ children?: Array<{ id?: string }> }>; nestedChildren?: Array<{ id?: string }> } | undefined;
			assert.deepEqual(completion?.nestedChildren?.map((child) => child.id), ["top-explicit-good"]);
			assert.deepEqual(completion?.results?.[0]?.children?.map((child) => child.id)?.sort(), ["child-explicit-good", "top-explicit-good"].sort());
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("retries and delivers result files after nested registry enrichment recovers", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-retry-"));
		const route = createNestedRoute("async-nested-retry");
		try {
			const registryPath = path.join(path.dirname(route.eventSink), "registry.json");
			fs.writeFileSync(registryPath, "{", "utf-8");
			writeNestedEvent(route, {
				type: "subagent.nested.completed",
				ts: 100,
				parentRunId: "async-nested-retry",
				parentStepIndex: 0,
				child: {
					id: "nested-retry-child",
					parentRunId: "async-nested-retry",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "async-nested-retry", stepIndex: 0 }],
					state: "complete",
					agent: "child",
				},
			});
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, listener: (payload: unknown) => void) {
						const set = listeners.get(event) ?? new Set();
						set.add(listener);
						listeners.set(event, set);
						return () => set.delete(listener);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const listener of listeners.get(event) ?? []) listener(data);
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const resultPath = path.join(resultsDir, "async-nested-retry.json");
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				fs.writeFileSync(resultPath, JSON.stringify({
					id: "async-nested-retry",
					runId: "async-nested-retry",
					agent: "owner",
					success: true,
					state: "complete",
					summary: "owner done",
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));

				assert.equal(fs.existsSync(resultPath), true);
				assert.equal(emitted.length, 0);
				assert.ok(
					logged.some((entry) => /will retry later/.test(String(entry[0] ?? ""))),
					"expected nested enrichment retry warning to be logged",
				);

				fs.rmSync(registryPath, { force: true });
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 650));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(resultPath), false);
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { nestedChildren?: Array<{ id?: string }> } | undefined;
			assert.deepEqual(completion?.nestedChildren?.map((child) => child.id), ["nested-retry-child"]);
			const intercomPayload = emitted.find((entry) => entry.event === "subagent:result-intercom")?.data as { children?: Array<{ children?: Array<{ id?: string }> }> } | undefined;
			assert.deepEqual(intercomPayload?.children?.[0]?.children?.map((child) => child.id), ["nested-retry-child"]);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("does not advertise indexed revive from only a top-level async session file", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					emit: (event: string, data: unknown) => {
						emitted.push({ event, data });
						for (const listener of listeners.get(event) ?? []) listener(data);
						return true;
					},
					on: (event: string, listener: (payload: unknown) => void) => {
						const set = listeners.get(event) ?? new Set();
						set.add(listener);
						listeners.set(event, set);
						return () => set.delete(listener);
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			try {
				fs.writeFileSync(path.join(resultsDir, "async-top-session.json"), JSON.stringify({
					id: "async-top-session",
					mode: "parallel",
					success: false,
					state: "failed",
					results: [
						{ agent: "a", output: "A", success: true },
						{ agent: "b", output: "B", success: false },
					],
					sessionId: "session-1",
					sessionFile: "/tmp/top-session.jsonl",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				watcher.stopResultWatcher();
			}

			const eventData = emitted.find((entry) => entry.event === "subagent:result-intercom")?.data as { message?: string } | undefined;
			assert.ok(eventData);
			assert.doesNotMatch(String(eventData.message ?? ""), /Revive child:/);
			assert.match(String(eventData.message ?? ""), /Resume: unavailable; no child session file was persisted/);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("marks grouped async results as paused when the result file is paused", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			try {
				fs.writeFileSync(path.join(resultsDir, "async-paused.json"), JSON.stringify({
					id: "async-paused",
					runId: "run-paused",
					agent: "chain:a->b",
					mode: "chain",
					success: false,
					state: "paused",
					summary: "Paused after interrupt. Waiting for explicit next action.",
					results: [
						{ agent: "a", output: "Result from a", success: true, intercomTarget: "subagent-a-run-paused-1" },
						{ agent: "b", output: "Paused after interrupt", success: false, intercomTarget: "subagent-b-run-paused-2" },
					],
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				watcher.stopResultWatcher();
			}

			const intercomEvents = emitted.filter((entry) => entry.event === "subagent:result-intercom");
			assert.equal(intercomEvents.length, 1);
			const payload = intercomEvents[0]?.data as { mode?: string; status?: string; message?: string; children?: Array<{ status?: string }> };
			assert.equal(payload.mode, "chain");
			assert.equal(payload.status, "paused");
			assert.equal(payload.children?.every((child) => child.status === "paused"), true);
			assert.match(String(payload.message ?? ""), /Status: paused/);
			assert.match(String(payload.message ?? ""), /1\. a — paused/);
			assert.match(String(payload.message ?? ""), /2\. b — paused/);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("logs one unacknowledged grouped async intercom delivery before completing", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on(_event: string, _handler: (payload: unknown) => void) {
						return () => {};
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				fs.writeFileSync(path.join(resultsDir, "async-2.json"), JSON.stringify({
					id: "async-2",
					runId: "run-456",
					agent: "worker",
					success: true,
					state: "complete",
					summary: "Worker summary",
					sessionId: "session-1",
					intercomTarget: "orchestrator",
				}), "utf-8");
				watcher.primeExistingResults();
				const deadline = Date.now() + 1000;
				while (true) {
					const sawWarning = logged.some((entry) => /Subagent async grouped result intercom delivery was not acknowledged/.test(String(entry[0] ?? "")));
					const sawCompletion = emitted.some((entry) => entry.event === "subagent:async-complete");
					if ((sawWarning && sawCompletion) || Date.now() > deadline) break;
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:result-intercom").length, 1);
			assert.equal(emitted.some((entry) => entry.event === "subagent:async-complete"), true);
			assert.equal(logged.some((entry) => /Subagent async grouped result intercom delivery was not acknowledged/.test(String(entry[0] ?? ""))), true);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});
});
