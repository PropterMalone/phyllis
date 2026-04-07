// pattern: functional-core
import { describe, expect, it } from "vitest";
import { applySetupPlan, planSetup } from "./setup.ts";

const PHYLLIS_HOME = "/home/testuser/.phyllis";
const CLAUDE_HOME = "/home/testuser/.claude";
const HOOKS_SRC = "/opt/phyllis/hooks";

describe("planSetup", () => {
	it("fresh install — no existing settings", () => {
		const plan = planSetup(null, PHYLLIS_HOME, CLAUDE_HOME, false, HOOKS_SRC);

		expect(plan.hooksDir).toBe("/home/testuser/.phyllis/hooks");
		expect(plan.settingsPath).toBe("/home/testuser/.claude/settings.json");
		expect(plan.hooksToAdd).toHaveLength(2);
		expect(plan.hooksToAdd[0].event).toBe("SessionEnd");
		expect(plan.hooksToAdd[1].event).toBe("StopFailure");
		expect(plan.statusLine).toEqual({
			command: "bash ~/.phyllis/hooks/statusline-command.sh",
		});
		expect(plan.warnings).toEqual([
			`hooks source directory not found: ${HOOKS_SRC}`,
		]);
	});

	it("existing statusline set to non-phyllis without --force warns and skips", () => {
		const existing = {
			statusLine: { type: "command", command: "bash ~/my-custom-status.sh" },
		};
		const plan = planSetup(
			existing,
			PHYLLIS_HOME,
			CLAUDE_HOME,
			false,
			HOOKS_SRC,
		);

		expect(plan.statusLine).toBeNull();
		expect(plan.warnings).toContainEqual(
			expect.stringContaining("statusline already configured"),
		);
		expect(plan.warnings).toContainEqual(
			expect.stringContaining("my-custom-status.sh"),
		);
	});

	it("existing statusline set to non-phyllis with --force overwrites with warning", () => {
		const existing = {
			statusLine: { type: "command", command: "bash ~/my-custom-status.sh" },
		};
		const plan = planSetup(
			existing,
			PHYLLIS_HOME,
			CLAUDE_HOME,
			true,
			HOOKS_SRC,
		);

		expect(plan.statusLine).toEqual({
			command: "bash ~/.phyllis/hooks/statusline-command.sh",
		});
		expect(plan.warnings).toContainEqual(
			expect.stringContaining("overwriting existing statusline"),
		);
	});

	it("existing phyllis statusline updates without warning", () => {
		const existing = {
			statusLine: {
				type: "command",
				command: "bash ~/.phyllis/hooks/old-statusline.sh",
			},
		};
		const plan = planSetup(
			existing,
			PHYLLIS_HOME,
			CLAUDE_HOME,
			false,
			HOOKS_SRC,
		);

		expect(plan.statusLine).toEqual({
			command: "bash ~/.phyllis/hooks/statusline-command.sh",
		});
		// Only the hooks dir warning, no statusline warning
		expect(plan.warnings.filter((w) => w.includes("statusline"))).toHaveLength(
			0,
		);
	});
});

describe("applySetupPlan", () => {
	function makePlan(
		overrides: Partial<ReturnType<typeof planSetup>> = {},
	): ReturnType<typeof planSetup> {
		return {
			hooksDir: "/home/testuser/.phyllis/hooks",
			hooksToCopy: [],
			hooksSrcDir: HOOKS_SRC,
			settingsPath: "/home/testuser/.claude/settings.json",
			hooksToAdd: [
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
			],
			statusLine: {
				command: "bash ~/.phyllis/hooks/statusline-command.sh",
			},
			warnings: [],
			...overrides,
		};
	}

	it("fresh install — builds complete settings from scratch", () => {
		const result = applySetupPlan(null, makePlan());

		expect(result.hooks).toBeDefined();
		const hooks = result.hooks as Record<string, unknown[]>;
		expect(hooks.SessionEnd).toHaveLength(1);
		expect(hooks.StopFailure).toHaveLength(1);

		const sessionEnd = hooks.SessionEnd[0] as {
			hooks: Array<{ type: string; command: string; timeout: number }>;
		};
		expect(sessionEnd.hooks[0].command).toBe(
			"bash ~/.phyllis/hooks/session-end-snapshot.sh",
		);
		expect(sessionEnd.hooks[0].timeout).toBe(30);

		expect(result.statusLine).toEqual({
			type: "command",
			command: "bash ~/.phyllis/hooks/statusline-command.sh",
		});
	});

	it("merges into existing hooks without overwriting user hooks", () => {
		const existing = {
			hooks: {
				SessionEnd: [
					{
						hooks: [
							{
								type: "command",
								command: "bash ~/my-session-end.sh",
								timeout: 10,
							},
						],
					},
				],
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: "bash ~/pre-tool.sh",
								timeout: 5,
							},
						],
					},
				],
			},
		};

		const result = applySetupPlan(existing, makePlan());
		const hooks = result.hooks as Record<string, unknown[]>;

		// SessionEnd should have both user's hook and Phyllis hook
		expect(hooks.SessionEnd).toHaveLength(2);
		const commands = (
			hooks.SessionEnd as Array<{
				hooks: Array<{ command: string }>;
			}>
		).map((e) => e.hooks[0].command);
		expect(commands).toContain("bash ~/my-session-end.sh");
		expect(commands).toContain("bash ~/.phyllis/hooks/session-end-snapshot.sh");

		// StopFailure added fresh
		expect(hooks.StopFailure).toHaveLength(1);

		// PreToolUse preserved
		expect(hooks.PreToolUse).toHaveLength(1);
	});

	it("updates existing phyllis hooks instead of duplicating", () => {
		const existing = {
			hooks: {
				SessionEnd: [
					{
						hooks: [
							{
								type: "command",
								command: "bash ~/my-session-end.sh",
								timeout: 10,
							},
						],
					},
					{
						hooks: [
							{
								type: "command",
								command: "bash ~/.phyllis/hooks/old-session-end.sh",
								timeout: 15,
							},
						],
					},
				],
			},
		};

		const result = applySetupPlan(existing, makePlan());
		const hooks = result.hooks as Record<string, unknown[]>;

		// Should still be 2 entries (user + updated phyllis), not 3
		expect(hooks.SessionEnd).toHaveLength(2);

		const phyllisEntry = (
			hooks.SessionEnd as Array<{
				hooks: Array<{ command: string; timeout: number }>;
			}>
		).find((e) => e.hooks[0].command.includes("phyllis"));

		expect(phyllisEntry?.hooks[0].command).toBe(
			"bash ~/.phyllis/hooks/session-end-snapshot.sh",
		);
		expect(phyllisEntry?.hooks[0].timeout).toBe(30);
	});

	it("does not set statusline when plan.statusLine is null", () => {
		const existing = {
			statusLine: {
				type: "command",
				command: "bash ~/my-custom-status.sh",
			},
		};

		const result = applySetupPlan(existing, makePlan({ statusLine: null }));

		expect((result.statusLine as { command: string }).command).toBe(
			"bash ~/my-custom-status.sh",
		);
	});

	it("preserves permissions and other settings fields", () => {
		const existing = {
			permissions: {
				allow: ["Read", "Write"],
				deny: ["Bash"],
			},
			apiKey: "sk-test-123",
			model: "claude-opus-4-6",
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: "bash ~/guard.sh",
								timeout: 5,
							},
						],
					},
				],
			},
		};

		const result = applySetupPlan(existing, makePlan());

		expect(result.permissions).toEqual({
			allow: ["Read", "Write"],
			deny: ["Bash"],
		});
		expect(result.apiKey).toBe("sk-test-123");
		expect(result.model).toBe("claude-opus-4-6");

		const hooks = result.hooks as Record<string, unknown[]>;
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.SessionEnd).toHaveLength(1);
		expect(hooks.StopFailure).toHaveLength(1);
	});
});
