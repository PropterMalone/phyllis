# Phyllis — Claude Code Usage Optimizer

> Meta-tracker that monitors token consumption across all projects and schedules deferrable work into empty usage windows.

Last verified: 2026-03-29

## Problem

Anthropic subscription plans have three rate-limit windows:
- **Session window**: ~5 hours, fixed reset time
- **Weekly all-models**: Resets Friday 3:00 PM
- **Weekly Sonnet-only**: Resets Tuesday 6:00 PM

Heavy sessions (NineAngel runs, episode pipelines, batch jobs) can exhaust a window, blocking interactive work. Meanwhile, overnight and meeting-hours windows go unused.

## Design

### v1 Scope

1. **Token parser** — Walk `~/.claude/projects/*/*.jsonl`, sum `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` + `output_tokens` per project per time window. No external API needed — data is already local.

2. **Task queue** — Deferrable tasks with t-shirt size estimates (S/M/L/XL). Human tags the size. Flat JSON file.

3. **Scheduler** — Cron that checks window state (time until reset, estimated % used) and drains the queue via `claude -p` when headroom exists.

### What we skip

- Precise token estimation engine — human tags tasks, historical baselines inform but don't automate
- Live Anthropic API usage queries — no known endpoint; approximate from local JSONL data
- Extra usage cost optimization — that's a billing concern, not a scheduling one

### Data sources

- **Session JSONL files**: `~/.claude/projects/-home-karl-Projects-*//*.jsonl` — each assistant message has a `usage` object with token counts and timestamps
- **history.jsonl**: `~/.claude/history.jsonl` — user messages with project path and session ID
- **Desktop app usage pane**: Shows exact % used and reset times (no API, but could scrape or reference for calibration)

### Key unknowns

- How Anthropic weights input vs output vs cache tokens for rate limiting
- Whether extra usage ($) consumption counts against the subscription window or is separate
- Exact token budget per window per plan tier (not publicly documented)

## Tech stack

TBD — likely TypeScript + Node.js, CLI-first. No hosting needed (runs on Malone).

## Commands

TBD

## File structure

TBD
