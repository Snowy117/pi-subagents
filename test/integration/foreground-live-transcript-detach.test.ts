import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgentConfigs, removeTempDir } from "../support/helpers.ts";
import { liveTranscriptPath, retainLiveTranscript } from "../../src/shared/live-transcript.ts";
import { INTERCOM_DETACH_REQUEST_EVENT } from "../../src/shared/types.ts";
import { available, runSync } from "../support/single-execution-harness.ts";

describe("foreground live transcript detach lifecycle", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});
	after(() => mockPi.uninstall());
	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});
	afterEach(() => removeTempDir(tempDir));

	it("keeps an artifact-off live transcript until a detached child actually exits", async () => {
		const eventBus = createEventBus();
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 200, jsonl: [events.assistantMessage("after detached reply")] },
			],
		});
		const runId = "detached-live-transcript";
		const transcriptPath = liveTranscriptPath(runId, 0);
		const release = retainLiveTranscript(transcriptPath, { id: () => "test-view" });
		let detachEmitted = false;

		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId,
			artifactsDir: tempDir,
			artifactConfig: { enabled: false },
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "live-transcript-detach" });
			},
		});

		assert.equal(result.detached, true);
		assert.equal(fs.existsSync(transcriptPath), true);
		release();
		for (let attempt = 0; attempt < 100 && fs.existsSync(transcriptPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(fs.existsSync(transcriptPath), false);
	});
});
