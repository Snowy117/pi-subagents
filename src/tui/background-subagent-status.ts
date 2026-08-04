import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WIDGET_KEY, type AsyncJobState } from "../shared/types.ts";

export function countBackgroundSubagents(
	jobs: AsyncJobState[],
	isSyncOwned: (runId: string, sessionId?: string) => boolean = () => false,
): number {
	let count = 0;
	for (const job of jobs) {
		if (job.status !== "queued" && job.status !== "running") continue;
		if (isSyncOwned(job.asyncId, job.sessionId)) continue;
		const activeSteps = job.steps?.filter((step) => step.status === "pending" || step.status === "running").length;
		const jobCount = activeSteps || job.stepsTotal || job.agents?.length || 1;
		count += Math.max(1, jobCount);
	}
	return count;
}

export function renderBackgroundSubagentStatus(
	ctx: ExtensionContext,
	jobs: AsyncJobState[],
	isSyncOwned: (runId: string, sessionId?: string) => boolean = () => false,
): number {
	const count = countBackgroundSubagents(jobs, isSyncOwned);
	if (!ctx.hasUI) return count;
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	ctx.ui.setStatus(WIDGET_KEY, count > 0 ? `${count} background subagent${count === 1 ? "" : "s"}` : undefined);
	return count;
}
