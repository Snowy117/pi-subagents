import type * as fs from "node:fs";
import * as path from "node:path";

/**
 * Opportunistic fast-path interrupt signal. On Unix `SIGUSR2` is trapped by the
 * runner; on Windows `process.kill(pid, "SIGBREAK")` is not deliverable
 * cross-process and throws `ENOSYS`, so the file inbox below is the real channel.
 */
export const INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

export type ControlChannelFs = Pick<typeof fs, "mkdirSync" | "existsSync" | "rmSync" | "watch" | "readdirSync" | "readFileSync">;
export type ControlChannelTimers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval };

export interface InterruptRequest {
	type: "interrupt";
	ts?: number;
	source?: string;
	reason?: string;
}

export interface TimeoutRequest {
	type: "timeout";
	ts?: number;
	source?: string;
	reason?: string;
}

export interface SteerRequest {
	type: "steer";
	id: string;
	ts: number;
	message: string;
	targetIndex?: number;
	source?: string;
}

const STEER_REQUESTS_DIR = "steer-requests";
const STEER_TARGETS_DIR = "steer-targets";

/** Control inbox directory inside an async run dir. */
export function controlInboxDir(asyncDir: string): string {
	return path.join(asyncDir, "control");
}

/** Path of the portable interrupt request file. */
export function interruptRequestPath(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), "interrupt.json");
}

/** Path of the portable timeout request file. */
export function timeoutRequestPath(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), "timeout.json");
}

/** Directory of parent-to-runner steering requests. */
export function steerRequestsDir(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), STEER_REQUESTS_DIR);
}

/** Per-child inbox consumed by the child prompt runtime inside the Pi process. */
export function stepSteerInboxDir(asyncDir: string, index: number): string {
	return path.join(controlInboxDir(asyncDir), STEER_TARGETS_DIR, String(index));
}
