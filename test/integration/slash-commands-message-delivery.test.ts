import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	available,
	clearSlashSnapshots,
	createCommandContext,
	createEventBus,
	createState,
	getSlashRenderableSnapshot,
	registerSlashCommands,
	resolveSlashMessageDetails,
	SLASH_RESULT_TYPE,
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	SLASH_SUBAGENT_STARTED_EVENT,
} from "../support/slash-test-setup.ts";
describe("slash command custom message delivery", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("/run accepts an agent without a task", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requestedParams: unknown;
		let requestedCtx: unknown;
		const sessionManager = {
			flushed: false,
			rewrites: 0,
			getSessionFile: () => "session.jsonl",
			_rewriteFile() {
				this.rewrites++;
			},
		};
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown; ctx?: unknown };
			requestedParams = payload.params;
			requestedCtx = payload.ctx;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "Commit finished" }],
					details: { mode: "single", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};

		const ctx = createCommandContext({ sessionManager });
		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout", ctx);

		assert.deepEqual(requestedParams, { agent: "scout", task: "", clarify: false, agentScope: "both" });
		assert.equal(requestedCtx, ctx);
		assert.equal(sent.length, 2);
		assert.equal((sent[0] as { display?: boolean }).display, true);
		assert.equal((sent[0] as { content?: string }).content, "Running subagent...");
		assert.equal((sent[1] as { display?: boolean }).display, true);
		assert.match((sent[1] as { content?: string }).content ?? "", /Commit finished/);
		assert.equal(sessionManager.rewrites, 2);
		assert.equal(sessionManager.flushed, true);
	});

	it("/run finalizes the slash snapshot before the last UI redraw on success", async () => {
		const sent: unknown[] = [];
		const log: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Scout finished" }],
					details: { mode: "single", results: [{ sessionFile: "/tmp/child-session.jsonl" }] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
				log.push(`send:${(message as { display?: boolean }).display === false ? "hidden" : "visible"}`);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext({
			hasUI: true,
			setStatus: (_key, text) => {
				log.push(`status:${text ?? "clear"}`);
			},
		}));

		assert.equal(sent.length, 2);
		assert.equal((sent[0] as { customType?: string; display?: boolean }).customType, SLASH_RESULT_TYPE);
		assert.equal((sent[0] as { display?: boolean }).display, true);
		assert.equal((sent[0] as { content?: string }).content, "inspect this");
		assert.equal((sent[1] as { customType?: string; display?: boolean }).customType, SLASH_RESULT_TYPE);
		assert.equal((sent[1] as { display?: boolean }).display, false);
		assert.match((sent[1] as { content?: string }).content ?? "", /Scout finished/);
		assert.match((sent[1] as { content?: string }).content ?? "", /Child session exports\n\n- `\/tmp\/child-session\.jsonl`/);
		assert.deepEqual(log, ["send:visible", "status:running...", "send:hidden", "status:clear"]);

		const visibleDetails = resolveSlashMessageDetails!((sent[0] as { details?: unknown }).details);
		assert.ok(visibleDetails);
		const visibleSnapshot = getSlashRenderableSnapshot!(visibleDetails!);
		assert.equal((visibleSnapshot.result.content[0] as { text?: string }).text, "Scout finished");
	});

	it("/run collapses tool detail before showing the initial live card", async () => {
		const log: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: { content: [{ type: "text", text: "done" }], details: { mode: "single", results: [] } },
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage() {
				log.push("send");
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext({
			hasUI: true,
			setToolsExpanded: (expanded) => log.push(`expanded:${String(expanded)}`),
		}));

		assert.deepEqual(log.slice(0, 2), ["expanded:false", "send"]);
	});

	it("/run finalizes the slash snapshot before the last UI redraw on error", async () => {
		const sent: unknown[] = [];
		const log: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Subagent failed" }],
					details: { mode: "single", results: [] },
				},
				isError: true,
				errorText: "Subagent failed",
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
				log.push(`send:${(message as { display?: boolean }).display === false ? "hidden" : "visible"}`);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext({
			hasUI: true,
			setStatus: (_key, text) => {
				log.push(`status:${text ?? "clear"}`);
			},
		}));

		assert.equal(sent.length, 2);
		assert.equal((sent[0] as { customType?: string; display?: boolean }).customType, SLASH_RESULT_TYPE);
		assert.equal((sent[0] as { display?: boolean }).display, true);
		assert.equal((sent[0] as { content?: string }).content, "inspect this");
		assert.equal((sent[1] as { customType?: string; display?: boolean }).customType, SLASH_RESULT_TYPE);
		assert.equal((sent[1] as { display?: boolean }).display, false);
		assert.match((sent[1] as { content?: string }).content ?? "", /Subagent failed/);
		assert.deepEqual(log, ["send:visible", "status:running...", "send:hidden", "status:clear"]);

		const visibleDetails = resolveSlashMessageDetails!((sent[0] as { details?: unknown }).details);
		assert.ok(visibleDetails);
		const visibleSnapshot = getSlashRenderableSnapshot!(visibleDetails!);
		assert.equal((visibleSnapshot.result.content[0] as { text?: string }).text, "Subagent failed");
	});

	it("/parallel forwards inline output behavior config", async () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requestedParams: unknown;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "parallel finished" }],
					details: { mode: "parallel", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(_message: unknown) {},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("parallel")!.handler("scout[output=x.md,outputMode=file-only,reads=a.md+b.md,progress] -- Review", createCommandContext());

		assert.deepEqual(requestedParams, {
			tasks: [{ agent: "scout", task: "Review", output: "x.md", outputMode: "file-only", reads: ["a.md", "b.md"], progress: true }],
			clarify: false,
			agentScope: "both",
		});
	});

	it("/parallel no longer hard-blocks runs above the old 8-task limit before the executor responds", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requestedTasks = 0;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: { tasks?: unknown[] } };
			requestedTasks = payload.params?.tasks?.length ?? 0;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "parallel finished" }],
					details: { mode: "parallel", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		const args = Array.from({ length: 9 }, (_, index) => `scout \"task ${index + 1}\"`).join(" -> ");
		await commands.get("parallel")!.handler(args, createCommandContext());

		assert.equal(requestedTasks, 9);
		assert.equal(sent.length, 2);
		assert.match((sent[1] as { content?: string }).content ?? "", /parallel finished/);
	});
});
