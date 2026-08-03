import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { initTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../../src/shared/types.ts";
import { handleSubagentsPicker } from "../../src/tui/steer-view/entry-shortcut.ts";
import type { SteerViewController } from "../../src/tui/steer-view/open-view.ts";
import { createSteerViewRuntime } from "../../src/tui/steer-view/registration.ts";
import type { SteerViewTarget } from "../../src/tui/steer-view/target-model.ts";

initTheme();

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function state(active = true): SubagentState {
	const value = {
		baseCwd: "/tmp", currentSessionId: "s", asyncJobs: new Map(), foregroundRuns: new Map(), foregroundLiveChildren: new Map(),
		foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null,
		completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} satisfies SubagentState;
	if (active) value.asyncJobs.set("run", { asyncId: "run", asyncDir: "/tmp/run", status: "running", agents: ["worker"] });
	return value;
}

function setup(editorText = "") {
	let opens = 0;
	const ctx = { ui: { getEditorText: () => editorText } } as unknown as ExtensionContext;
	const controller = { modalOpen: false, open: async () => { opens++; }, close: () => {}, dispose: () => {} } as SteerViewController;
	return { ctx, controller, opens: () => opens };
}

describe("subagent picker shortcut", () => {
	it("consumes only a configured key with an empty editor, active target, and no modal", async () => {
		const input = setup();
		assert.deepEqual(handleSubagentsPicker("\x1b[B", input.ctx, state(), input.controller, ["down"], { listRuns: () => [] }), { consume: true });
		await Promise.resolve();
		assert.equal(input.opens(), 1);
	});

	it("passes through non-target input, editor text, disabled config, no targets, and modal state", () => {
		const empty = setup();
		assert.equal(handleSubagentsPicker("x", empty.ctx, state(), empty.controller, ["down"], { listRuns: () => [] }), undefined);
		assert.equal(handleSubagentsPicker("\x1b[B", setup("text").ctx, state(), empty.controller, ["down"], { listRuns: () => [] }), undefined);
		assert.equal(handleSubagentsPicker("\x1b[B", empty.ctx, state(), empty.controller, [], { listRuns: () => [] }), undefined);
		assert.equal(handleSubagentsPicker("\x1b[B", empty.ctx, state(false), empty.controller, ["down"], { listRuns: () => [] }), undefined);
		Object.defineProperty(empty.controller, "modalOpen", { value: true });
		assert.equal(handleSubagentsPicker("\x1b[B", empty.ctx, state(), empty.controller, ["down"], { listRuns: () => [] }), undefined);
	});

	it("passes the configured session root to degraded transcript rendering", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "steer-runtime-"));
		roots.push(root);
		const transcriptPath = path.join(root, "transcript.jsonl");
		fs.writeFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", ts: 1, role: "assistant", text: "trusted transcript" })}\n`);
		const currentState = state(false);
		currentState.asyncJobs.set("trusted-run", {
			asyncId: "trusted-run", asyncDir: root, status: "running", agents: ["delegate"], updatedAt: 1,
			steps: [{ index: 0, agent: "delegate", status: "running", transcriptPath }],
		});
		const selected: SteerViewTarget = {
			key: "async:trusted-run:0", kind: "async", runId: "trusted-run", index: 0, agent: "delegate",
			status: "running", active: true, updatedAt: 1, asyncDir: root, transcriptPath,
		};
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as Theme;
		let customCalls = 0;
		let rendered = "";
		const ctx = {
			hasUI: true,
			cwd: root,
			sessionManager: { getSessionFile: () => undefined },
			ui: {
				custom: async (factory: (...args: unknown[]) => unknown) => {
					customCalls++;
					if (customCalls === 1) return selected;
					const component = factory(
						{ terminal: { rows: 12 }, requestRender() {} },
						theme,
						{},
						() => {},
					) as { render(width: number): string[]; dispose(): void };
					rendered = component.render(80).join("\n");
					component.dispose();
					return { kind: "slash", text: "/done" };
				},
				getToolsExpanded: () => false,
				setEditorText() {},
				notify() {},
			},
		} as unknown as ExtensionContext;
		const runtime = createSteerViewRuntime(currentState, { defaultSessionDir: root });
		try {
			await runtime.controller.open(ctx);
			assert.match(rendered, /trusted transcript/);
		} finally {
			runtime.dispose();
		}
	});
});
