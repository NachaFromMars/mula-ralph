# Auto-Resume — Checkpointing + Recovery

## Vấn Đề

OpenClaw gateway có thể restart bất kỳ lúc nào:
- Update
- Config change
- Crash
- Manual restart

Khi restart, sub-agents bị kill. Ralph loops phải resume được.

## Giải Pháp: File-Based State

### State Persistence

Mỗi iteration, state được save:

```javascript
async function saveState(state) {
  const path = `~/.openclaw/workspace/missions/${state.id}.json`;
  await fs.writeFile(path, JSON.stringify(state, null, 2));
}
```

State chứa đủ thông tin để resume:
- Task description
- Current iteration
- Working directory
- Last output (context)
- Config (max iterations, promise, model)

### Resume Flow

```
Gateway restart
       │
       ▼
HEARTBEAT fires
       │
       ▼
Check missions/*.json
       │
       ▼
Find status="running"
       │
       ▼
Check sub-agent alive?
       │
  ┌────┴────┐
  │ ALIVE   │ NO (killed)
  │ skip    │
  └────┬────┘
       │
       ▼
Resume loop from checkpoint
       │
       ▼
Notify user: "🔄 Ralph resumed"
```

## Checkpoint Data

### Minimum Required

```json
{
  "id": "ralph-todo-api-20260308",
  "task": "Build REST API for todos",
  "dir": "/home/user/projects/todo-api",
  "currentIteration": 15,
  "maxIterations": 30,
  "promise": "COMPLETE",
  "status": "running"
}
```

### Full Checkpoint

```json
{
  "id": "ralph-todo-api-20260308",
  "task": "Build REST API for todos",
  "dir": "/home/user/projects/todo-api",
  "currentIteration": 15,
  "maxIterations": 30,
  "promise": "COMPLETE",
  "status": "running",
  "model": "claudible/claude-opus-4.6",
  "lastOutput": "Created POST /todos endpoint...",
  "outputHistory": ["...", "...", "..."],
  "config": {
    "minIterationGap": 30,
    "stuckThreshold": 3
  },
  "createdAt": "2026-03-08T10:00:00Z",
  "updatedAt": "2026-03-08T12:30:00Z",
  "resumeCount": 0
}
```

## Resume Logic

### CLI Resume

```bash
node scripts/mula-ralph.mjs resume --id ralph-todo-api-20260308
```

### Auto Resume (HEARTBEAT)

```javascript
// In HEARTBEAT handler
async function autoResumeRalphLoops() {
  const missions = await findMissions('running');
  
  for (const mission of missions) {
    const agentAlive = await checkSubAgent(mission.subAgentId);
    
    if (!agentAlive) {
      console.log(`🔄 Resuming Ralph: ${mission.id}`);
      
      mission.resumeCount = (mission.resumeCount || 0) + 1;
      
      if (mission.resumeCount > 3) {
        mission.status = 'abandoned';
        await saveState(mission);
        await notify(`❌ Ralph abandoned after 3 resumes: ${mission.task}`);
        continue;
      }
      
      await resumeLoop(mission);
      await notify(`🔄 Ralph resumed (attempt ${mission.resumeCount}): ${mission.task}`);
    }
  }
}
```

## Resume Prompt

Khi resume, prompt có thêm context:

```markdown
# Task: {{task}}

## Resume Context
You are resuming from iteration {{currentIteration}}.
Previous work summary:
{{lastOutput}}

Your previous outputs indicate you were working on:
- [extracted from outputHistory]

Continue from where you left off.

## Instructions
[same as normal]
```

## Edge Cases

### 1. Rapid Restart

```
Gateway restart → resume → restart ngay → resume lại
```

**Solution:** `resumeCount` tracking. Max 3 resumes, sau đó abandon.

### 2. Stale State

State file cũ (> 24h) có thể outdated.

**Solution:**
```javascript
const staleThreshold = 24 * 60 * 60 * 1000; // 24h
if (Date.now() - new Date(state.updatedAt) > staleThreshold) {
  console.warn(`⚠️ State is stale (${state.updatedAt}). Consider starting fresh.`);
}
```

### 3. Working Dir Changed

Project moved hoặc deleted.

**Solution:**
```javascript
if (!fs.existsSync(state.dir)) {
  state.status = 'error';
  state.error = `Working directory no longer exists: ${state.dir}`;
  await saveState(state);
}
```

### 4. Concurrent Resumes

HEARTBEAT race condition: 2 resumes cùng lúc.

**Solution:** Lock file hoặc atomic update.

```javascript
async function resumeLoop(state) {
  const lockPath = `${state.path}.lock`;
  if (fs.existsSync(lockPath)) {
    console.log(`Loop already being resumed: ${state.id}`);
    return;
  }
  
  fs.writeFileSync(lockPath, process.pid.toString());
  try {
    // Resume logic
  } finally {
    fs.unlinkSync(lockPath);
  }
}
```

## Manual Recovery

### Force Fresh Start

```bash
# Delete state, start over
rm ~/.openclaw/workspace/missions/ralph-todo-api-*.json
node scripts/mula-ralph.mjs run --task "..." --dir ...
```

### Edit State

```bash
# Manual edit để fix stuck
vi ~/.openclaw/workspace/missions/ralph-todo-api-20260308.json
# Change currentIteration, clear outputHistory, etc.
```

### Resume With Modified Task

```bash
node scripts/mula-ralph.mjs resume \
  --id ralph-todo-api-20260308 \
  --task "Updated task with more details..."
```
