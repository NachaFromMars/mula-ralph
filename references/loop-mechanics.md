# Loop Mechanics — Chi Tiết Logic Vòng Lặp

## Lifecycle Một Vòng Lặp

```
┌─────────────────────────────────────────────────────────────┐
│                    LOOP START                               │
│  1. Load state (hoặc init state mới)                        │
│  2. Check pre-conditions (max iterations, circuit breaker)  │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    EXECUTE ITERATION                        │
│  1. Build prompt (task + iteration number + instructions)  │
│  2. Spawn sub-agent hoặc execute trong main session         │
│  3. Wait for response                                       │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    ANALYZE RESPONSE                         │
│  1. Check completion promise (<done>X</done>)              │
│  2. Check stuck indicator (identical output 3x)            │
│  3. Extract work summary                                    │
└────────────────────────┬────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
┌─────────────────────┐   ┌─────────────────────┐
│   PROMISE FOUND     │   │   NO PROMISE        │
│   status = done     │   │   iteration += 1    │
│   cleanup + notify  │   │   save state        │
│   EXIT              │   │   CONTINUE LOOP     │
└─────────────────────┘   └─────────────────────┘
```

## Prompt Construction

Mỗi iteration, prompt được build từ template:

```markdown
# Task: {{task}}

## Instructions
1. Continue working on the task
2. When complete, output exactly: <done>{{promise}}</done>
3. If stuck, describe what's blocking and output: <done>STUCK</done>

## Context
- Iteration: {{currentIteration}}/{{maxIterations}}
- Working directory: {{dir}}
- Previous output summary: {{lastOutputSummary}}

## Rules
- Focus on one step at a time
- Test your changes
- Commit frequently
- Do NOT fake completion — only output promise when truly done
```

## Promise Detection

### Format

```xml
<done>COMPLETE</done>
<done>STUCK</done>
<done>BLOCKED: reason</done>
```

### Extraction Logic

```javascript
function extractPromise(output) {
  const match = output.match(/<done>(.*?)<\/done>/s);
  if (match) {
    return {
      found: true,
      value: match[1].trim()
    };
  }
  return { found: false };
}
```

### Validation

- Promise phải exact match với expected value (case-sensitive)
- COMPLETE ≠ Complete ≠ complete
- Whitespace bên trong được normalize

## Iteration Tracking

### State Update Per Iteration

```javascript
state.currentIteration += 1;
state.lastOutput = response.text.slice(0, 1000); // Truncate
state.outputHistory.push(response.text.slice(0, 500));
state.outputHistory = state.outputHistory.slice(-5); // Keep last 5
state.updatedAt = new Date().toISOString();
```

### Progress Detection

Agent làm progress khi:
- Git commits mới (detect qua `git log`)
- Files changed (detect qua `git status`)
- Tests pass count tăng
- Build/lint errors giảm

Không progress sau 3 iterations → potential stuck.

## Output Comparison (Stuck Detection)

### Algorithm

```javascript
function isStuck(outputHistory) {
  if (outputHistory.length < 3) return false;
  
  const last3 = outputHistory.slice(-3);
  const normalized = last3.map(o => normalizeOutput(o));
  
  return normalized[0] === normalized[1] && 
         normalized[1] === normalized[2];
}

function normalizeOutput(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/iteration \d+/g, 'iteration X')
    .replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')
    .trim()
    .slice(0, 500);
}
```

### Stuck Handling

1. Detect stuck → không exit ngay
2. Inject "stuck hint" vào prompt tiếp theo:
   ```
   ⚠️ STUCK DETECTED: You've produced similar output 3 times.
   Try a different approach or explain what's blocking you.
   ```
3. Nếu stuck thêm 2 iterations → force exit với status="stuck"

## Sub-Agent Execution

### OpenClaw sessions_spawn

```javascript
const result = await sessions_spawn({
  task: `Ralph loop iteration ${iteration}`,
  message: buildPrompt(state),
  model: state.model || 'claudible/claude-opus-4.6',
  notify: true // Notify khi xong
});
```

### Wait Strategy

- Không poll liên tục (tốn token)
- Dùng notify callback
- Timeout: 30 phút/iteration (configurable)

## File-Based State

### State File Location

```
~/.openclaw/workspace/missions/ralph-{task-slug}-{timestamp}.json
```

### State Schema

```typescript
interface RalphState {
  id: string;
  task: string;
  dir: string;
  maxIterations: number;
  currentIteration: number;
  promise: string;
  status: 'running' | 'done' | 'stuck' | 'cancelled' | 'error';
  lastOutput: string;
  outputHistory: string[];
  model: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}
```

## Exit Conditions

| Condition | Status | Action |
|-----------|--------|--------|
| Promise found | done | Cleanup, notify success |
| Max iterations | done | Cleanup, notify partial |
| Stuck 5 times | stuck | Cleanup, notify stuck |
| User cancel | cancelled | Cleanup, notify cancelled |
| Sub-agent error | error | Retry 1x, then cleanup |
| Gateway restart | running | Resume via HEARTBEAT |

## Retry Logic

### Sub-Agent Failure

```
Attempt 1: spawn → error
Wait: 30 seconds
Attempt 2: spawn → error
Exit: status = error, log error details
```

### Network/API Failure

```
Attempt 1: API call → timeout
Wait: 60 seconds
Attempt 2: API call → success
Continue loop
```

Max retries: 2 per iteration.
