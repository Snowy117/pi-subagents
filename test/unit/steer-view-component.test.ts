import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { claimControlActionRequests, writeControlActionResponse } from "../../src/runs/shared/control-actions/channel.ts";
import { SteerViewComponent, type SteerViewResult } from "../../src/tui/steer-view/steer-view-component.ts";
import type { SteerViewTarget } from "../../src/tui/steer-view/target-model.ts";

// Native components (UserMessageComponent et al.) resolve the active theme
// through pi's global theme; the extension calls initTheme at startup, unit
// tests must do the same before assembling (see child-conversation-assembler).
initTheme();

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function harness(refreshTarget?: () => SteerViewTarget | undefined, getToolsExpanded?: () => boolean) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "steer-component-"));
	roots.push(root);
	const transcriptPath = path.join(root, "transcript.jsonl");
	fs.writeFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", ts: 1, role: "user", text: "initial" })}\n`);
	const target: SteerViewTarget = {
		key: "foreground:run:0", kind: "foreground", runId: "run", index: 0, agent: "worker",
		status: "running", active: true, updatedAt: 1, transcriptPath,
		steerInboxDir: path.join(root, "steer"), actionControlDir: path.join(root, "action"),
		trustedRoots: [root],
	};
	let renders = 0;
	const tui = { terminal: { rows: 14 }, requestRender: () => { renders++; } } as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	const results: SteerViewResult[] = [];
	const component = new SteerViewComponent(tui, theme, target, (result) => results.push(result), { autoStart: false, refreshTarget, getToolsExpanded });
	return { root, target, component, results, renders: () => renders, transcriptPath };
}

describe("SteerViewComponent", () => {
	it("propagates focus and bounds every rendered line", () => {
		const { component } = harness();
		component.focused = true;
		assert.equal(component.focused, true);
		for (const line of component.render(24)) assert.ok(visibleWidth(line) <= 24, `${visibleWidth(line)}: ${line}`);
		component.dispose();
	});

	it("renders read-only surface with continuity-unavailable header and no input row", () => {
		const { component } = harness();
		const out = component.render(50).join("\n");
		assert.match(out, /continuity/);
		assert.match(out, /read-only/);
		// No input prompt-style line in the rendered output.
		assert.doesNotMatch(out, /[>] /);
		component.dispose();
	});

	it("printable characters do nothing to the read-only surface", () => {
		const { component } = harness();
		const before = component.render(50).join("\n");
		for (const character of "hello") component.handleInput(character);
		const after = component.render(50).join("\n");
		assert.equal(after, before);
		component.dispose();
	});

	it("routes shift-tab by request id and displays the applied actual level", () => {
		const { component, target } = harness();
		component.handleInput("\x1b[Z");
		const request = claimControlActionRequests(target.actionControlDir!)[0]!;
		assert.equal(request.action, "cycleThinking");
		writeControlActionResponse(target.actionControlDir!, {
			version: 1, type: "action_response", requestId: request.id, ts: Date.now(),
			status: "applied", action: "cycleThinking", result: { thinkingLevel: "high" },
		});
		component.poll();
		assert.match(component.render(60).join("\n"), /thinking high/);
		component.dispose();
	});

	it("displays a rejected thinking response error", () => {
		const { component, target } = harness();
		component.handleInput("\x1b[Z");
		const request = claimControlActionRequests(target.actionControlDir!)[0]!;
		writeControlActionResponse(target.actionControlDir!, {
			version: 1, type: "action_response", requestId: request.id, ts: Date.now(),
			status: "rejected", action: "cycleThinking", error: "model has no reasoning levels",
		});
		component.poll();
		assert.match(component.render(80).join("\n"), /Thinking rejected: model has no reasoning levels/);
		component.dispose();
	});

	it("supports scroll keys and Esc back", () => {
		const { component, results } = harness();
		component.handleInput("\x1b[5~");
		component.handleInput("\x1b[6~");
		component.handleInput("\x1b");
		assert.deepEqual(results, [{ kind: "picker" }]);
		component.dispose();
	});

	it("does not request a render on an idle poll with no new records", () => {
		const { component, renders } = harness();
		// Construction polls once and renders the seeded record.
		const afterConstruction = renders();
		assert.ok(afterConstruction >= 1);
		// No new transcript records, no pending action responses: idle poll
		// must not force a full TUI render.
		component.poll();
		component.poll();
		assert.equal(renders(), afterConstruction);
		component.dispose();
	});

	it("scrolls through a single Markdown message that wraps to many terminal rows", () => {
		const { component, transcriptPath } = harness();
		fs.appendFileSync(transcriptPath, `${JSON.stringify({
			recordType: "message",
			ts: 2,
			role: "assistant",
			text: Array.from({ length: 30 }, (_, index) => `wrapped-${index}`).join(" "),
		})}\n`);
		component.poll();
		const atBottom = component.render(18).join("\n");
		component.handleInput("\x1b[5~");
		const scrolled = component.render(18).join("\n");
		assert.notEqual(scrolled, atBottom);
		component.dispose();
	});

	it("renders the degraded header and native components for full message records", () => {
		const { component, transcriptPath } = harness(undefined, () => true);
		fs.appendFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", ts: 2, role: "user", message: { role: "user", content: [{ type: "text", text: "hello worker" }] } })}\n`);
		fs.appendFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", ts: 3, role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I will read the file." }, { type: "toolCall", id: "call-1", name: "read", arguments: { filePath: "a.ts" } }] } })}\n`);
		fs.appendFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", ts: 4, role: "toolResult", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "result contents" }] } })}\n`);
		component.poll();
		const out = component.render(80).join("\n");
		assert.match(out, /continuity unavailable/);
		assert.match(out, /hello worker/);
		assert.match(out, /I will read the file/);
		assert.match(out, /result contents/);
		component.dispose();

		// Collapsed default (getToolsExpanded absent): the paired tool card
		// shows its name without the result body, like the main view.
		const collapsed = harness();
		fs.appendFileSync(collapsed.transcriptPath, `${JSON.stringify({ recordType: "message", ts: 2, role: "assistant", message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "grep", arguments: { pattern: "x" } }] } })}\n`);
		collapsed.component.poll();
		assert.match(collapsed.component.render(80).join("\n"), /grep/);
		collapsed.component.dispose();
	});

	it("attaches to a transcript path discovered after a queued target starts", () => {
		const setup = harness();
		const discoveredPath = path.join(setup.root, "discovered.jsonl");
		fs.writeFileSync(discoveredPath, `${JSON.stringify({ recordType: "message", ts: 2, role: "assistant", text: "started" })}\n`);
		delete setup.target.transcriptPath;
		let refreshes = 0;
		const tui = { terminal: { rows: 10 }, requestRender() {} } as unknown as TUI;
		const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
		const component = new SteerViewComponent(tui, theme, setup.target, () => {}, {
			autoStart: false,
			refreshTarget: () => (++refreshes > 1 ? { ...setup.target, transcriptPath: discoveredPath } : setup.target),
		});
		component.poll();
		assert.match(component.render(40).join("\n"), /started/);
		component.dispose();
		setup.component.dispose();
	});
});