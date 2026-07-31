import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { claimControlActionRequests, writeControlActionResponse } from "../../src/runs/shared/control-actions/channel.ts";
import { consumeSteerRequestsFromDir, steerDeliveryMarker } from "../../src/runs/background/control-channel.ts";
import { SteerViewComponent, type SteerViewResult } from "../../src/tui/steer-view/steer-view-component.ts";
import type { SteerViewTarget } from "../../src/tui/steer-view/target-model.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function harness(refreshTarget?: () => SteerViewTarget | undefined) {
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
	const component = new SteerViewComponent(tui, theme, target, (result) => results.push(result), { autoStart: false, refreshTarget });
	return { root, target, component, results, renders: () => renders, transcriptPath };
}

describe("SteerViewComponent", () => {
	it("propagates focus for IME and bounds every rendered line", () => {
		const { component } = harness();
		component.focused = true;
		assert.equal(component.focused, true);
		for (const line of component.render(24)) assert.ok(visibleWidth(line) <= 24, `${visibleWidth(line)}: ${line}`);
		component.dispose();
	});

	it("sends steer, reports queued, and confirms from transcript", () => {
		const { component, target, transcriptPath } = harness();
		for (const character of "guide") component.handleInput(character);
		component.handleInput("\r");
		const request = consumeSteerRequestsFromDir(target.steerInboxDir!)[0]!;
		assert.equal(request.message, "guide");
		assert.match(component.render(50).join("\n"), /Steer queued/);
		fs.appendFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", ts: Date.now() + 1, role: "user", text: "guide" })}\n`);
		component.poll();
		assert.match(component.render(50).join("\n"), /Steer queued/);
		fs.appendFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", ts: Date.now() + 2, role: "user", text: `guide\n${steerDeliveryMarker(request.id)}` })}\n`);
		component.poll();
		assert.match(component.render(50).join("\n"), /steer delivered/);
		component.dispose();
	});

	it("rejects direct foreground control after the live target disappears", () => {
		const { component, target } = harness(() => undefined);
		component.input.setValue("too late");
		component.handleInput("\r");
		assert.match(component.render(50).join("\n"), /no longer available/);
		assert.equal(fs.existsSync(target.steerInboxDir!), false);
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

	it("supports scroll keys, Esc back, and slash close results", () => {
		const first = harness();
		first.component.handleInput("\x1b[5~");
		first.component.handleInput("\x1b[6~");
		first.component.handleInput("\x1b");
		assert.deepEqual(first.results, [{ kind: "picker" }]);
		first.component.dispose();

		const second = harness();
		for (const character of "/other-command") second.component.handleInput(character);
		second.component.handleInput("\r");
		assert.deepEqual(second.results, [{ kind: "slash", text: "/other-command" }]);
		second.component.dispose();
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
