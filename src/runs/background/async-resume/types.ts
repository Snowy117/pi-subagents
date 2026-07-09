import type { AsyncStatus } from "../../../shared/types.ts";

export const ASYNC_RESUME_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

export interface AsyncResumeParams {
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
}

export interface AsyncResumeDeps {
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

export interface AsyncResumeOptions {
	requireSessionFile?: boolean;
}

export type AsyncResumeTarget = {
	kind: "live" | "revive";
	runId: string;
	asyncDir?: string;
	state: AsyncStatus["state"];
	agent: string;
	index: number;
	intercomTarget: string;
	cwd?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
};

export type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;
