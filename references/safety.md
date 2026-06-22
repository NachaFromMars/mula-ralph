# Safety Features — Circuit Breaker + Rate Limiting

## 1. Max Iterations (Hard Limit)

### Mục đích
Chống loop vô hạn khi task impossible hoặc prompt sai.

### Config

```javascript
{
  maxIterations: 30,      // Default
  minIterations: 1,       // Tối thiểu
  maxMaxIterations: 100   // Không cho set quá cao
}
```

### Behavior

- Iteration 30/30 → stop, status = "done" (partial)
- Notify user: "Ralph completed 30 iterations. Task may be incomplete."
- Lưu state để user có thể review + resume

### Recommendation

| Task Type | Suggested Max |
|-----------|---------------|
| Bug fix | 10-15 |
| Small feature | 20-30 |
| Large feature | 40-60 |
| Greenfield project | 80-100 |

## 2. Circuit Breaker (Stuck Detection)

### Mục đích
Detect khi agent lặp lại cùng output → stuck → stop sớm.

### Thresholds

```javascript
{
  stuckThreshold: 3,        // 3 identical outputs = stuck warning
  stuckForceExit: 5,        // 5 identical outputs = force exit
  stuckCooldown: 2          // 2 different outputs sau stuck warning = reset
}
```

### Logic Flow

```
Output 1: "Created endpoint..."
Output 2: "Running tests..."
Output 3: "Tests passing..." (different)
→ No stuck

Output 4: "Need to fix auth"
Output 5: "Need to fix auth" (same)
Output 6: "Need to fix auth" (same)
→ Stuck warning injected

Output 7: "Trying different approach..."
Output 8: "New method working..." (different)
→ Stuck reset

Output 9: "Still stuck on auth"
Output 10: "Still stuck on auth"
Output 11: "Still stuck on auth"
Output 12: "Still stuck on auth"
Output 13: "Still stuck on auth"
→ Force exit (5 consecutive)
```

### Stuck Injection

Khi stuck detected (3x), inject vào prompt tiếp:

```markdown
⚠️ **STUCK DETECTED**

You've produced similar output 3 times in a row. This suggests you're stuck.

Please try:
1. A completely different approach
2. Breaking the problem into smaller steps
3. Reading error messages more carefully
4. Checking documentation
5. If truly blocked, output: <done>STUCK: [reason]</done>

Do NOT repeat the same approach.
```

## 3. Rate Limiting

### OpenClaw Integration

Ralph respects OpenClaw's built-in rate limiting:
- Per-minute limits
- Per-hour limits
- Token budgets

### Ralph-Specific Limits

```javascript
{
  minIterationGap: 30,      // 30 seconds minimum between iterations
  maxIterationsPerHour: 60, // 1/minute average
  cooldownOnLimit: 300      // 5 minutes cooldown when hit
}
```

### Behavior When Limited

```
Iteration 45: spawn → rate limited
Wait: 5 minutes (cooldownOnLimit)
Retry: spawn → success
Continue
```

### Manual Override

```bash
# Bypass rate limiting (use with caution)
node scripts/mula-ralph.mjs run --no-rate-limit ...
```

## 4. Session Isolation

### Mục đích
Nhiều Ralph loops chạy cùng lúc không conflict.

### Implementation

- Mỗi loop có unique ID: `ralph-{task-slug}-{timestamp}`
- State file riêng: `missions/{id}.json`
- Sub-agent session riêng

### Conflict Detection

```javascript
// Trước khi start loop mới
const existing = await findRunningLoops(dir);
if (existing.length > 0) {
  console.warn(`⚠️ Another loop running in ${dir}: ${existing[0].id}`);
  console.warn(`Cancel it first: mula-ralph cancel --id ${existing[0].id}`);
  process.exit(1);
}
```

## 5. Clean Exit

### Normal Exit (Promise Found)

```javascript
async function exitClean(state) {
  state.status = 'done';
  state.completedAt = new Date().toISOString();
  await saveState(state);
  await notify(`✅ Ralph complete: ${state.task}`);
  // Keep state file for reference
}
```

### Cancel Exit

```javascript
async function exitCancel(state) {
  state.status = 'cancelled';
  await saveState(state);
  await notify(`🛑 Ralph cancelled: ${state.task}`);
  // Cleanup sub-agent if running
  await killSubAgent(state.subAgentId);
}
```

### Error Exit

```javascript
async function exitError(state, error) {
  state.status = 'error';
  state.error = error.message;
  await saveState(state);
  await notify(`❌ Ralph error: ${state.task}\n${error.message}`);
}
```

## 6. Resource Guards

### Memory

```javascript
// Truncate outputs to prevent state file bloat
state.lastOutput = state.lastOutput.slice(0, 1000);
state.outputHistory = state.outputHistory.map(o => o.slice(0, 500));
```

### Disk

```javascript
// Cleanup old state files (> 7 days)
const oldStates = await findOldStates(7);
for (const s of oldStates) {
  if (s.status !== 'running') {
    await fs.unlink(s.path);
  }
}
```

### CPU/API

```javascript
// Minimum gap between iterations
await sleep(state.config.minIterationGap * 1000);
```

## 7. Emergency Stop

### Via CLI

```bash
node scripts/mula-ralph.mjs cancel --id <loop-id> --force
```

### Via State File

```bash
# Manual edit
echo '{"status": "cancelled"}' > missions/<loop-id>.json
```

### Via HEARTBEAT

```markdown
# HEARTBEAT.md

## Emergency Stop All Loops
If you see this, STOP ALL RALPH LOOPS immediately.
```

## Best Practices

1. **Always set max-iterations** — không để unlimited
2. **Start small** — 10 iterations first, increase if needed
3. **Monitor first run** — watch logs for stuck/loops
4. **Use notify** — get alerts when complete/stuck
5. **Review state files** — check progress periodically
