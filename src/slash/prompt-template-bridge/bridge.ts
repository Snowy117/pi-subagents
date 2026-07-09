import {
	PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT,
	type PromptTemplateBridgeOptions,
	type PromptTemplateDelegationParallelResult,
	type PromptTemplateDelegationResponse,
	buildDelegationMessages,
	firstTextContent,
	parsePromptTemplateRequest,
	toDelegationUpdate,
} from "./core.ts";

export function registerPromptTemplateDelegationBridge<Ctx extends { cwd?: string }>(
	options: PromptTemplateBridgeOptions<Ctx>,
): {
	cancelAll: () => void;
	dispose: () => void;
} {
	const controllers = new Map<string, AbortController>();
	const pendingCancels = new Set<string>();
	const subscriptions: Array<() => void> = [];

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};

	subscribe(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
		if (!data || typeof data !== "object") return;
		const requestId = (data as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string") return;
		const controller = controllers.get(requestId);
		if (controller) {
			controller.abort();
			return;
		}
		pendingCancels.add(requestId);
	});

	subscribe(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, async (data) => {
		const request = parsePromptTemplateRequest(data);
		if (!request) return;

		const ctx = options.getContext();
		if (!ctx) {
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages: [],
				isError: true,
				errorText: "No active extension context for delegated subagent execution.",
			};
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
			return;
		}

		const controller = new AbortController();
		controllers.set(request.requestId, controller);

		if (pendingCancels.delete(request.requestId)) {
			controller.abort();
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages: [],
				isError: true,
				errorText: "Delegated prompt cancelled.",
			};
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
			controllers.delete(request.requestId);
			return;
		}

		options.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });

		try {
			const result = await options.execute(
				request.requestId,
				request,
				controller.signal,
				ctx,
				(update) => {
					const payload = toDelegationUpdate(request.requestId, update);
					if (!payload) return;
					options.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, payload);
				},
			);
			const contentText = firstTextContent(result.content);
			const messages = buildDelegationMessages(result.details?.results?.[0] ?? {}, contentText);
			const parallelResults = request.tasks
				? request.tasks.map<PromptTemplateDelegationParallelResult>((task, index) => {
					const step = result.details?.results?.[index];
					if (!step) {
						return {
							agent: task.agent,
							messages: [],
							isError: true,
							errorText: "Missing result for delegated parallel task.",
						};
					}
					const exitCode = typeof step.exitCode === "number" ? step.exitCode : undefined;
					const errorText = step.error;
					return {
						agent: step.agent ?? task.agent,
						messages: buildDelegationMessages(step),
						isError: (exitCode !== undefined && exitCode !== 0) || !!errorText,
						errorText: errorText || undefined,
					};
				})
				: undefined;
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages,
				...(parallelResults ? { parallelResults } : {}),
				...(contentText ? { contentText } : {}),
				isError: result.isError === true,
				errorText: result.isError ? contentText : undefined,
			};
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
		} catch (error) {
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages: [],
				isError: true,
				errorText: error instanceof Error ? error.message : String(error),
			};
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
		} finally {
			controllers.delete(request.requestId);
		}
	});

	return {
		cancelAll: () => {
			for (const controller of controllers.values()) {
				controller.abort();
			}
			controllers.clear();
			pendingCancels.clear();
		},
		dispose: () => {
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.length = 0;
			pendingCancels.clear();
		},
	};
}
