// pattern: functional-core + imperative-shell
// Setup: install Phyllis hooks into Claude Code settings

import { readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface HookEntry {
	event: string; // "SessionEnd" | "StopFailure"
	command: string;
	timeout: number;
}

export interface SetupPlan {
	hooksDir: string; // ~/.phyllis/hooks/
	hooksToCopy: string[]; // filenames to copy
	hooksSrcDir: string; // source directory for hook scripts
	settingsPath: string; // ~/.claude/settings.json
	hooksToAdd: HookEntry[]; // hooks to merge into settings
	statusLine: { command: string } | null; // null if already set to non-phyllis and no --force
	warnings: string[];
}

const PHYLLIS_HOOKS: HookEntry[] = [
	{
		event: "SessionEnd",
		command: "bash ~/.phyllis/hooks/session-end-snapshot.sh",
		timeout: 30,
	},
	{
		event: "StopFailure",
		command: "bash ~/.phyllis/hooks/stop-failure-throttle.sh",
		timeout: 5,
	},
];

const PHYLLIS_STATUSLINE = {
	command: "bash ~/.phyllis/hooks/statusline-command.sh",
};

function isPhyllisCommand(command: string): boolean {
	return command.includes("phyllis");
}

// Pure: plan what setup needs to do
export function planSetup(
	existingSettings: Record<string, unknown> | null,
	phyllisHome: string,
	claudeHome: string,
	force: boolean,
	hooksSrcDir: string,
): SetupPlan {
	const hooksDir = join(phyllisHome, "hooks");
	const settingsPath = join(claudeHome, "settings.json");
	const warnings: string[] = [];

	// Determine hook files to copy
	let hooksToCopy: string[] = [];
	try {
		hooksToCopy = readdirSync(hooksSrcDir).filter((f) => f.endsWith(".sh"));
	} catch {
		warnings.push(`hooks source directory not found: ${hooksSrcDir}`);
	}

	// Determine statusline
	let statusLine: { command: string } | null = PHYLLIS_STATUSLINE;
	if (existingSettings) {
		const existing = existingSettings.statusLine as
			| { command?: string; type?: string }
			| undefined;
		if (existing?.command) {
			if (isPhyllisCommand(existing.command)) {
				// Already Phyllis — update is fine
			} else if (force) {
				warnings.push(`overwriting existing statusline: ${existing.command}`);
			} else {
				warnings.push(
					`statusline already configured: ${existing.command} (use --force to overwrite)`,
				);
				statusLine = null;
			}
		}
	}

	return {
		hooksDir,
		hooksToCopy,
		hooksSrcDir,
		settingsPath,
		hooksToAdd: PHYLLIS_HOOKS,
		statusLine,
		warnings,
	};
}

// Pure: apply plan to settings object
export function applySetupPlan(
	existingSettings: Record<string, unknown> | null,
	plan: SetupPlan,
): Record<string, unknown> {
	const settings = existingSettings ? { ...existingSettings } : {};

	// Merge hooks
	const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
	const mergedHooks = { ...existingHooks };

	for (const hook of plan.hooksToAdd) {
		const hookPayload = {
			hooks: [
				{
					type: "command" as const,
					command: hook.command,
					timeout: hook.timeout,
				},
			],
		};

		const eventArray = (mergedHooks[hook.event] ?? []) as Array<{
			hooks?: Array<{ command?: string }>;
		}>;

		// Find existing Phyllis entry for this event
		const phyllisIdx = eventArray.findIndex((entry) =>
			entry.hooks?.some((h) => h.command && isPhyllisCommand(h.command)),
		);

		if (phyllisIdx >= 0) {
			// Update existing Phyllis hook
			const updated = [...eventArray];
			updated[phyllisIdx] = hookPayload;
			mergedHooks[hook.event] = updated;
		} else {
			// Append new Phyllis hook
			mergedHooks[hook.event] = [...eventArray, hookPayload];
		}
	}

	settings.hooks = mergedHooks;

	// Set statusline if plan says so
	if (plan.statusLine) {
		settings.statusLine = {
			type: "command",
			command: plan.statusLine.command,
		};
	}

	return settings;
}

// Imperative: execute the setup
export async function setup(options: {
	phyllisHome: string;
	claudeHome: string;
	hooksSrcDir: string;
	force: boolean;
}): Promise<SetupPlan> {
	const { phyllisHome, claudeHome, hooksSrcDir, force } = options;

	// Read existing settings
	const settingsPath = join(claudeHome, "settings.json");
	let existingSettings: Record<string, unknown> | null = null;
	try {
		const content = await readFile(settingsPath, "utf-8");
		existingSettings = JSON.parse(content) as Record<string, unknown>;
	} catch {
		// No existing settings
	}

	const plan = planSetup(
		existingSettings,
		phyllisHome,
		claudeHome,
		force,
		hooksSrcDir,
	);

	// Create hooks directory
	await mkdir(plan.hooksDir, { recursive: true });

	// Copy hook scripts
	for (const filename of plan.hooksToCopy) {
		const src = join(plan.hooksSrcDir, filename);
		const dest = join(plan.hooksDir, filename);
		await copyFile(src, dest);
	}

	// Create/ensure Claude settings directory
	await mkdir(claudeHome, { recursive: true });

	// Apply and write settings
	const newSettings = applySetupPlan(existingSettings, plan);
	await writeFile(settingsPath, `${JSON.stringify(newSettings, null, 2)}\n`);

	return plan;
}
