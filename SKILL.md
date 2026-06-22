---
name: mula-ralph
description: "Self-driving agent loop — spawn sub-agent iteratively until task complete. Agent orchestrates, script manages state. Features: promise detection, stuck detection, circuit breaker, auto-resume. Dùng khi: build feature tự động, code task lớn cần iterate, autonomous coding loop. Triggers: ralph loop, mula-ralph, self-driving, autonomous loop, auto code, loop task."
---

# Mula Ralph — Self-Driving Agent Loop for OpenClaw

> "Spawn. Poll. Check. Repeat. Until done."

## Tổng Quan

Mula Ralph = agent loop tự chạy:
1. Tạo loop → script khởi tạo state
2. Agent spawn sub-agent với prompt
3. Sub-agent làm việc → trả output
4. Script check output: promise? stuck? max iterations?
5. Nếu chưa xong → build prompt mới → spawn lại
6. Loop đến khi done

**Architecture:** Script (`mula-ralph.mjs`) quản lý STATE. Agent (bạn) quản lý EXECUTION.

Script không thể gọi sessions_spawn — đó là OpenClaw internal tool. Agent đọc SKILL.md → orchestrate tools → dùng script cho state.

Fork từ:
- [Ralph Loop](https://github.com/anthropics/claude-code/tree/main/contrib) (Anthropic)
- [ralph-claude-code](https://github.com/frankbria/ralph-claude-code) (frankbria)

## Khi Nào Dùng

✅ Build feature tự động (spawn sub-agent code)
✅ Task lớn cần nhiều lượt iterate
✅ Autonomous coding loop
❌ Simple one-liner (edit trực tiếp)
❌ Task cần human input mỗi step (dùng mula-forge-code)

## Protocol — Agent Follow Exactly

### Bước 1: Init

```bash
node scripts/mula-ralph.mjs init \
  --task "Build REST API with 5 endpoints" \
  --dir ~/project \
  --max-iterations 20
```

Script trả JSON:
```json
{
  "ok": true,
  "action": "init",
  "id": "ralph-build-rest-api-20260308T100000",
  "prompt": "# Task\nBuild REST API..."
}
```

### Bước 2: Spawn Sub-Agent

Dùng `sessions_spawn` với prompt từ init:

```
sessions_spawn(
  agentId: "kilo",
  message: <prompt from init>,
  model: "claudible/claude-opus-4.6"
)
```

### Bước 3: Poll Sub-Agent

```
subagents(action: "list")  → check if running
sessions_history(sessionKey: <key>)  → get output
```

Hoặc dùng `process(action=poll, timeout=60000)` nếu dùng exec.

### Bước 4: Record + Check

```bash
node scripts/mula-ralph.mjs iterate \
  --id ralph-build-rest-api-20260308T100000 \
  --output "Created 3/5 endpoints. Users and Posts done."
```

Script trả:
```json
{
  "ok": true,
  "action": "continue",    // or "done"
  "iteration": 1,
  "stuck": false,
  "prompt": "# Task\n...\n## Previous Work\nCreated 3/5 endpoints..."
}
```

### Bước 5: Continue or Stop

- `action: "continue"` → Spawn sub-agent lại với new prompt (Bước 2)
- `action: "done"` → Loop finished! Report to user.
- `stuck: true` → Prompt has stuck warning injected

### Loop Diagram

```
Agent: init → [spawn → poll → iterate → check]* → done
                  ↑__________________________|
```

## Completion Promise

Sub-agent outputs `<done>COMPLETE</done>` khi task xong.
Script detects và stops loop.

Custom promise: `--promise "SHIPPED"`

## Stuck Detection

| Condition | Action |
|-----------|--------|
| 3 identical outputs | Inject warning prompt (try different approach) |
| 5 identical outputs | Force exit (status: stuck) |

## Auto-Resume (HEARTBEAT)

Sau gateway restart, agent chết. HEARTBEAT resume:

```bash
# Check running loops
node scripts/mula-ralph.mjs check

# Resume specific loop
node scripts/mula-ralph.mjs resume --id <id>
```

Returns prompt to re-spawn agent. Max 3 resumes, then abandoned.

## CLI Reference

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `init` | Create loop | `--task --dir [--max-iterations] [--model]` |
| `iterate` | Record result | `--id --output` |
| `check` | Get state (JSON) | `[--id]` (no id = list running) |
| `resume` | Resume paused | `--id` |
| `done` | Mark complete | `--id [--reason]` |
| `fail` | Mark failed | `--id --reason` |
| `cancel` | Cancel | `--id` |
| `status` | Human-readable | `--id` |
| `list` | List all | - |

## Modes

### Mode 1: Sub-Agent (Recommended)
Agent spawns sub-agent via `sessions_spawn`. Best for complex tasks.

### Mode 2: HEARTBEAT
Add to HEARTBEAT.md:
```
## Auto-Resume Ralph Loops
1. Run: node ~/.openclaw/workspace/skills/mula-ralph/scripts/mula-ralph.mjs check
2. For each running loop: resume + spawn sub-agent
```

### Mode 3: Cron
Schedule check every 30 min via cron job.

## Safety

- **Max iterations** default 30 (configurable)
- **Circuit breaker** at 5 identical outputs
- **Rate limit** built into prompt (agent pace)
- **Max resumes** 3 (then abandoned)
- **State file** survives restart

## Structure

```
mula-ralph/
├── SKILL.md                  # This file
├── scripts/
│   └── mula-ralph.mjs        # State manager CLI (14KB)
├── references/
│   ├── loop-mechanics.md      # Deep dive on loop patterns
│   ├── openclaw-integration.md # How to use with OpenClaw tools
│   ├── resume.md              # Auto-resume patterns
│   └── safety.md              # Safety constraints
└── openbuild/                 # Build docs (PRD, acceptance, etc.)
```
