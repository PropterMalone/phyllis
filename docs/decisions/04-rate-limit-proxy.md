---
id: 04-rate-limit-proxy
name: Transparent HTTP proxy to capture Anthropic's undocumented rate-limit headers
date: 2026-04-12
status: active
supersedes: null
commits: [4a259fb, 60d8483, 680735b]
---

# Rate-limit proxy for undocumented Anthropic headers

**Decision**: Phyllis runs a transparent HTTP proxy in front of all Claude Code traffic, intercepting `anthropic-ratelimit-unified-*` response headers from every API call. Captured fields: per-window utilization (0-1), window reset timestamps, the binding window (which one is the tight constraint), and threshold warnings. Live state is written to a cache file the scheduler reads on every decision; resets and 429s are appended to the calibration log as discrete events. The proxy is the bridge between Anthropic's undocumented headers (which the API returns but doesn't publish) and Phyllis's empirical calibration loop (ADR 01).

**Why**: Anthropic's API does return rate-limit headers — they just don't document them and don't publish a quota endpoint. The headers are the closest thing to ground truth Phyllis can get: they're computed by Anthropic, they're tied to the actual binding constraints, and they update in real time. Without intercepting them, Phyllis is limited to indirect signals (ccusage token counts, desktop-app % readouts) that are minutes-to-hours stale. The proxy turns ephemeral response headers into persistent state Phyllis can query. The headers being undocumented is a known risk; capturing them is the only way to have any per-request ground truth at all.

**Rejected alternatives**:
- **Modify Claude Code itself to log the headers.** Rejected because Claude Code is closed-source vendor software; patching it would break on every update. The proxy is external — Claude Code is unmodified, Phyllis owns the proxy.
- **Read headers from `~/.claude/projects/*/sessions/*.jsonl`.** Rejected because the JSONL files don't include per-request HTTP response headers (only token usage objects). The proxy is the only path to the actual `anthropic-ratelimit-*` headers.
- **A native HTTP interceptor library (e.g., monkey-patching the SDK's fetch).** Rejected because Phyllis isn't the process making the API calls — Claude Code is. Process-internal interception requires being in the same process; the proxy works across processes by design.
- **Don't capture headers; rely on ccusage + desktop-app calibration alone.** Rejected because the latency on those signals (minutes for ccusage, hours for desktop-app) means the scheduler is always making decisions on stale data. Live header data closes the loop.

**Could-be-wrong-if**:
- Anthropic stops sending the `anthropic-ratelimit-unified-*` headers, OR renames them, OR changes the semantics. Concrete signal: the proxy logs zero header captures after a deploy, OR the headers' values don't track with observed quota behavior. Mitigation: the calibration log records the header values; if they stop arriving, alert; fall back to ccusage + desktop-app data while a fix is shipped. The proxy is a load-bearing dependency on undocumented behavior — that's a known risk.
- The proxy mis-routes or drops traffic, breaking Claude Code itself. Concrete signal: Claude Code requests fail or hang when the proxy is active. Mitigation: proxy must be transparent — passthrough on any unhandled case; bypass on any internal proxy error; never fail-closed. Phyllis is an optimizer; breaking the primary product is unacceptable.
- The captured headers are accurate but the scheduler's interpretation is wrong (e.g., "binding window" semantics misunderstood). Concrete signal: scheduling decisions consistently diverge from observed quota behavior despite proxy data being captured. Mitigation: cross-reference proxy data against ccusage and desktop-app readouts in the calibration log; tune the interpretation when divergences appear.

**How to apply**: Any new signal source about quota state from the Anthropic API (a new header, a new response field, a structured error body) gets wired into the proxy capture pipeline — the proxy is the single point of header observability. The live state cache file is the scheduler's read interface; never have the scheduler talk to the proxy directly (decoupling). When the proxy needs to be restarted (config change, code update), Claude Code traffic must continue working — verify passthrough behavior first. Treat header semantics as a hypothesis to be validated against calibration data, not as gospel from the API.
