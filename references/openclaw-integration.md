# OpenClaw Integration — HEARTBEAT, Cron, Missions

## 3 Modes Tích Hợp

| Mode | Cơ chế | Use Case |
|------|--------|----------|
| Sub-Agent | sessions_spawn | Recommended. Parallel với main session |
| HEARTBEAT | Main session loop | Simple tasks, no sub-agent overhead |
| Cron | Scheduled jobs | Background, low-priority tasks |

## Mode 1: Sub-Agent (Recommended)

### Flow

```
Main Agent
    │
    ├─ mula-ralph run → spawn sub-agent
    │
    ├─ Sub-agent works on loop
    │   ├─ Iteration 1
    │   ├─ Iteration 2
    │   └─ ...
    │
    ├─ Main agent continues other work
    │
    └─ Sub-agent notifies when done
```

### Implementation

```javascript
// mula-ralph.mjs
async function runSubAgentLoop(state) {
  const prompt = buildPrompt(state);
  
  const result = await sessions_spawn({
    task: `Ralph loop: ${state.task.slice(0, 50)}...`,
    message: prompt,
    model: state.model,
    notify: true
  });
  
  state.subAgentId = result.sessionKey;
  await saveState(state);
}
```

### Pros/Cons

✅ Parallel với main session
✅ Không block user chat
✅ Clear isolation

❌ Sub-agent limit (tùy config)
❌ Overhead spawn/notify

## Mode 2: HEARTBEAT Loop

### Flow

```
HEARTBEAT fires (every 30 min)
    │
    ├─ Check HEARTBEAT.md for active Ralph
    │
    ├─ If active:
    │   ├─ Read state from file
    │   ├─ Execute 1 iteration
    │   ├─ Save state
    │   └─ Check completion
    │
    └─ Reply HEARTBEAT_OK
```

### HEARTBEAT.md Setup

```markdown
# HEARTBEAT Checklist

## Ralph Loop Active
- ID: ralph-todo-api-20260308
- Task: Build REST API for todos
- Dir: ~/projects/todo-api
- Iteration: 5/30
- Status: running

## Instructions
1. Đọc state từ missions/ralph-todo-api-20260308.json
2. Execute 1 iteration của Ralph loop
3. Save state
4. Check completion (promise found?)
5. Nếu complete hoặc stuck → notify Nấng
```

### Pros/Cons

✅ No sub-agent needed
✅ Simple setup
✅ Integrated with existing HEARTBEAT

❌ Iterations tied to HEARTBEAT interval
❌ Blocks HEARTBEAT for other tasks
❌ 1 iteration per heartbeat (slow)

## Mode 3: Cron Loop

### Setup

```javascript
// Create cron job
await cron.create({
  name: 'ralph-todo-api',
  schedule: '*/10 * * * *', // Every 10 minutes
  agentTurn: true,
  model: 'claudible/claude-opus-4.6',
  systemEvent: `Ralph loop iteration.
    State: ~/.openclaw/workspace/missions/ralph-todo-api-20260308.json
    Read state, execute 1 iteration, save state.
    If complete, delete this cron job.`
});
```

### Cron Agent Prompt

```markdown
You are executing a Ralph loop iteration.

State file: [path]

1. Read state file
2. Execute iteration based on state.task
3. Update state (currentIteration, lastOutput)
4. Check for completion promise
5. If complete:
   - Update status to "done"
   - Notify: "✅ Ralph complete: [task]"
   - Delete this cron job: cron.delete('ralph-todo-api')
6. If stuck (3 same outputs):
   - Update status to "stuck"
   - Notify: "⚠️ Ralph stuck: [task]"
   - Delete this cron job
```

### Pros/Cons

✅ True background
✅ Survives session close
✅ Low overhead

❌ Slow (cron interval)
❌ Complex setup
❌ Hard to monitor

## Mission Directory

### Structure

```
~/.openclaw/workspace/missions/
├── ralph-todo-api-20260308100000.json
├── ralph-auth-feature-20260307153000.json
└── ralph-test-suite-20260306120000.json
```

### Naming Convention

```
ralph-{task-slug}-{YYYYMMDDHHMMSS}.json
```

### Cleanup

```javascript
// Auto cleanup old missions (ran by HEARTBEAT weekly)
async function cleanupOldMissions() {
  const missions = await fs.readdir(MISSIONS_DIR);
  const now = Date.now();
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  
  for (const file of missions) {
    const state = await readJson(join(MISSIONS_DIR, file));
    const age = now - new Date(state.updatedAt).getTime();
    
    if (age > maxAge && state.status !== 'running') {
      await fs.unlink(join(MISSIONS_DIR, file));
    }
  }
}
```

## Integration với MISSION-CONTROL.md

Nếu workspace đã có MISSION-CONTROL protocol:

```markdown
# MISSION-CONTROL.md

## Active Missions

### Ralph: todo-api
- ID: ralph-todo-api-20260308
- Type: ralph-loop
- Status: running
- Iteration: 15/30
- Resume: node scripts/mula-ralph.mjs resume --id ralph-todo-api-20260308
```

## Notify Channels

### Telegram (Default)

```javascript
await message({
  to: 'telegram:-5145317212', // Group chat
  message: `✅ Ralph complete: ${state.task}`
});
```

### Memory Log

```javascript
await nmem_remember({
  content: `Ralph loop "${state.task}" completed after ${state.currentIteration} iterations.`,
  type: 'event'
});
```

## Error Handling

### Sub-Agent Crash

```javascript
// In HEARTBEAT auto-resume
if (state.status === 'running' && !await isSubAgentAlive(state.subAgentId)) {
  await resumeLoop(state);
}
```

### API Rate Limit

```javascript
// Exponential backoff
let delay = 60000; // 1 minute
for (let retry = 0; retry < 3; retry++) {
  try {
    await executeIteration(state);
    break;
  } catch (e) {
    if (e.message.includes('rate limit')) {
      await sleep(delay);
      delay *= 2;
    } else {
      throw e;
    }
  }
}
```

### State Corruption

```javascript
try {
  const state = JSON.parse(await fs.readFile(statePath));
  validateState(state); // Throws if invalid
} catch (e) {
  console.error(`Corrupted state: ${statePath}`);
  await fs.rename(statePath, `${statePath}.corrupted`);
  // User must manually fix or restart
}
```
