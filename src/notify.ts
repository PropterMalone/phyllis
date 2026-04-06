// pattern: imperative-shell
// Task completion notifications via signal-cli.

import { execFileSync } from "node:child_process";
import type { NotifyConfig } from "./config.ts";

export function sendNotification(
	config: NotifyConfig,
	message: string,
): void {
	try {
		execFileSync("signal-cli", [
			"-a", config.signalAccount,
			"send",
			"-m", message,
			config.signalRecipient,
		], { timeout: 30_000, stdio: "ignore" });
	} catch (err) {
		// Notification failures are never fatal
		console.error(
			`[notify] signal send failed: ${(err as Error).message.slice(0, 100)}`,
		);
	}
}

export function formatTaskNotification(
	taskName: string,
	success: boolean,
	durationMs: number,
	reason: string,
): string {
	const status = success ? "\u2705" : "\u274c";
	const dur = Math.round(durationMs / 60_000);
	const durStr = dur >= 60 ? `${Math.floor(dur / 60)}h${dur % 60}m` : `${dur}m`;
	return `${status} Phyllis: ${taskName}\n${success ? "Done" : "Failed"} (${durStr}) — ${reason}`;
}
