#!/usr/bin/env node
/**
 * mula-ralph.mjs — Self-driving loop STATE MANAGER for OpenClaw
 * 
 * This script manages loop state (create, read, update, delete).
 * The actual execution (spawn agent, poll, iterate) is done by the 
 * OpenClaw agent following SKILL.md protocol.
 * 
 * Why? Because sessions_spawn/subagents/process are OpenClaw internal 
 * tools — not callable from a Node.js script. The agent orchestrates.
 * This script handles persistent state.
 * 
 * Usage:
 *   node mula-ralph.mjs init --task "Build API" --dir ~/project --max-iterations 30
 *   node mula-ralph.mjs iterate --id <id> --output "Agent output text..."
 *   node mula-ralph.mjs check --id <id>
 *   node mula-ralph.mjs done --id <id> --reason "Promise found"
 *   node mula-ralph.mjs fail --id <id> --reason "Stuck after 5 iterations"
 *   node mula-ralph.mjs cancel --id <id>
 *   node mula-ralph.mjs status --id <id>
 *   node mula-ralph.mjs list
 * 
 * Fork: Ralph Loop (Anthropic) + ralph-claude-code (frankbria)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

// --- Config ---
const MISSIONS_DIR = join(homedir(), '.openclaw', 'workspace', 'missions');
const STUCK_THRESHOLD = 3;
const STUCK_FORCE_EXIT = 5;

// --- Helpers ---
function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return null; }
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
}

function statePath(id) {
  return join(MISSIONS_DIR, `${id}.json`);
}

function normalizeOutput(text) {
  if (!text) return '';
  return text.toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/iteration \d+/g, 'iteration X')
    .replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')
    .replace(/\d{2}:\d{2}:\d{2}/g, 'TIME')
    .trim()
    .slice(0, 500);
}

function extractPromise(output) {
  if (!output) return { found: false };
  const match = output.match(/<done>(.*?)<\/done>/s);
  return match ? { found: true, value: match[1].trim() } : { found: false };
}

function isStuck(history, threshold = STUCK_THRESHOLD) {
  if (history.length < threshold) return false;
  const recent = history.slice(-threshold).map(normalizeOutput);
  return recent.every(o => o === recent[0] && o.length > 0);
}

// --- Commands ---

/** init: Create new loop state */
function cmdInit(task, dir, options = {}) {
  const id = `ralph-${slugify(task)}-${timestamp()}`;
  const maxIterations = parseInt(options.maxIterations || 30);
  const model = options.model || 'claudible/claude-opus-4.6';
  const promise = options.promise || 'COMPLETE';
  
  // Check working dir
  const absDir = resolve(dir);
  if (!existsSync(absDir)) {
    console.error(`❌ Directory not found: ${absDir}`);
    process.exit(1);
  }
  
  // Check no other loop in same dir
  ensureDir(MISSIONS_DIR);
  const existing = readdirSync(MISSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readJson(join(MISSIONS_DIR, f)))
    .filter(s => s && s.status === 'running' && s.dir === absDir);
  
  if (existing.length > 0) {
    console.error(`❌ Loop already running in ${absDir}: ${existing[0].id}`);
    process.exit(1);
  }
  
  const state = {
    id,
    task,
    dir: absDir,
    maxIterations,
    model,
    promise,
    status: 'running',
    currentIteration: 0,
    lastOutput: '',
    outputHistory: [],  // normalized outputs for stuck detection
    stuckCount: 0,
    resumeCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  writeJson(statePath(id), state);
  
  // Output JSON for agent to parse
  console.log(JSON.stringify({
    ok: true,
    action: 'init',
    id,
    task,
    dir: absDir,
    maxIterations,
    model,
    prompt: buildPrompt(state)
  }));
}

/** iterate: Record iteration result, return next action */
function cmdIterate(id, output) {
  const state = loadOrDie(id);
  
  if (state.status !== 'running') {
    console.log(JSON.stringify({ ok: false, error: `Loop not running: ${state.status}` }));
    process.exit(1);
  }
  
  // Record iteration
  state.currentIteration++;
  state.lastOutput = (output || '').slice(0, 2000);
  state.outputHistory.push(normalizeOutput(output));
  
  // Keep history bounded
  if (state.outputHistory.length > 20) {
    state.outputHistory = state.outputHistory.slice(-20);
  }
  
  // Check promise
  const promiseResult = extractPromise(output);
  if (promiseResult.found) {
    state.status = 'done';
    state.completedAt = new Date().toISOString();
    state.completionReason = `Promise found: ${promiseResult.value}`;
    save(state);
    console.log(JSON.stringify({
      ok: true,
      action: 'done',
      reason: 'promise_found',
      value: promiseResult.value,
      iterations: state.currentIteration
    }));
    return;
  }
  
  // Check max iterations
  if (state.currentIteration >= state.maxIterations) {
    state.status = 'done';
    state.completedAt = new Date().toISOString();
    state.completionReason = 'Max iterations reached';
    save(state);
    console.log(JSON.stringify({
      ok: true,
      action: 'done',
      reason: 'max_iterations',
      iterations: state.currentIteration
    }));
    return;
  }
  
  // Check stuck
  let stuck = false;
  let forceExit = false;
  
  if (isStuck(state.outputHistory, STUCK_FORCE_EXIT)) {
    forceExit = true;
    state.status = 'stuck';
    state.completedAt = new Date().toISOString();
    state.completionReason = `Force exit: ${STUCK_FORCE_EXIT} identical outputs`;
    save(state);
    console.log(JSON.stringify({
      ok: true,
      action: 'done',
      reason: 'stuck_force_exit',
      iterations: state.currentIteration
    }));
    return;
  }
  
  if (isStuck(state.outputHistory, STUCK_THRESHOLD)) {
    stuck = true;
    state.stuckCount++;
  } else {
    state.stuckCount = 0;
  }
  
  // Continue — build next prompt
  save(state);
  console.log(JSON.stringify({
    ok: true,
    action: 'continue',
    iteration: state.currentIteration,
    maxIterations: state.maxIterations,
    stuck,
    stuckCount: state.stuckCount,
    prompt: buildPrompt(state, stuck)
  }));
}

/** check: Get current state (for HEARTBEAT resume check) */
function cmdCheck(id) {
  if (id) {
    const state = loadOrDie(id);
    console.log(JSON.stringify({
      ok: true,
      id: state.id,
      status: state.status,
      iteration: state.currentIteration,
      maxIterations: state.maxIterations,
      task: state.task,
      dir: state.dir,
      model: state.model,
      resumeCount: state.resumeCount,
      prompt: state.status === 'running' ? buildPrompt(state) : null
    }));
  } else {
    // List all running loops
    ensureDir(MISSIONS_DIR);
    const running = readdirSync(MISSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => readJson(join(MISSIONS_DIR, f)))
      .filter(s => s && s.status === 'running');
    
    console.log(JSON.stringify({
      ok: true,
      running: running.map(s => ({
        id: s.id,
        task: s.task.slice(0, 60),
        iteration: s.currentIteration,
        maxIterations: s.maxIterations,
        dir: s.dir,
        resumeCount: s.resumeCount
      }))
    }));
  }
}

/** resume: Mark loop for resume, increment resumeCount */
function cmdResume(id) {
  const state = loadOrDie(id);
  
  if (state.status === 'running') {
    // Already running, just return prompt
    console.log(JSON.stringify({
      ok: true,
      action: 'continue',
      iteration: state.currentIteration,
      prompt: buildPrompt(state)
    }));
    return;
  }
  
  state.resumeCount = (state.resumeCount || 0) + 1;
  
  if (state.resumeCount > 3) {
    state.status = 'abandoned';
    save(state);
    console.log(JSON.stringify({
      ok: false,
      error: 'Max resumes exceeded (3). Loop abandoned.',
      id
    }));
    return;
  }
  
  state.status = 'running';
  save(state);
  
  console.log(JSON.stringify({
    ok: true,
    action: 'resume',
    id,
    resumeCount: state.resumeCount,
    iteration: state.currentIteration,
    prompt: buildPrompt(state)
  }));
}

/** done/fail/cancel: Terminal states */
function cmdTerminate(id, status, reason) {
  const state = loadOrDie(id);
  state.status = status;
  state.completedAt = new Date().toISOString();
  state.completionReason = reason || status;
  save(state);
  console.log(JSON.stringify({ ok: true, action: status, id, iterations: state.currentIteration }));
}

/** status: Human-readable status */
function cmdStatus(id) {
  const state = loadOrDie(id);
  console.log(`📊 Ralph Loop: ${state.id}`);
  console.log(`Task: ${state.task}`);
  console.log(`Dir: ${state.dir}`);
  console.log(`Status: ${state.status}`);
  console.log(`Iteration: ${state.currentIteration}/${state.maxIterations}`);
  console.log(`Model: ${state.model}`);
  console.log(`Resume count: ${state.resumeCount}`);
  console.log(`Created: ${state.createdAt}`);
  console.log(`Updated: ${state.updatedAt}`);
  if (state.completedAt) console.log(`Completed: ${state.completedAt}`);
  if (state.completionReason) console.log(`Reason: ${state.completionReason}`);
  if (state.lastOutput) console.log(`Last output: ${state.lastOutput.slice(0, 200)}...`);
}

/** list: Human-readable list */
function cmdList() {
  ensureDir(MISSIONS_DIR);
  const files = readdirSync(MISSIONS_DIR).filter(f => f.endsWith('.json'));
  
  if (files.length === 0) {
    console.log('No Ralph loops found.');
    return;
  }
  
  const states = files.map(f => readJson(join(MISSIONS_DIR, f))).filter(Boolean);
  const byStatus = {};
  states.forEach(s => {
    (byStatus[s.status] = byStatus[s.status] || []).push(s);
  });
  
  console.log(`📋 Ralph Loops (${states.length})\n`);
  
  for (const [status, loops] of Object.entries(byStatus)) {
    const icon = { running: '▶️', done: '✅', stuck: '⚠️', cancelled: '🛑', abandoned: '💀', error: '❌' }[status] || '❓';
    console.log(`${icon} ${status.toUpperCase()} (${loops.length}):`);
    loops.forEach(s => {
      console.log(`  ${s.id}`);
      console.log(`    ${s.task.slice(0, 60)} | ${s.currentIteration}/${s.maxIterations} | ${s.updatedAt}`);
    });
    console.log();
  }
}

// --- Prompt Builder ---
function buildPrompt(state, stuck = false) {
  let p = `# Task\n${state.task}\n\n`;
  p += `## Context\n`;
  p += `- Working directory: ${state.dir}\n`;
  p += `- Iteration: ${state.currentIteration + 1}/${state.maxIterations}\n`;
  p += `- Model: ${state.model}\n\n`;
  
  if (state.currentIteration > 0 && state.lastOutput) {
    p += `## Previous Work\n`;
    p += `${state.lastOutput.slice(0, 1000)}\n\n`;
    p += `Continue from where you left off.\n\n`;
  }
  
  if (stuck) {
    p += `## ⚠️ STUCK DETECTED\n\n`;
    p += `You've produced similar output ${STUCK_THRESHOLD} times. Try:\n`;
    p += `1. A completely different approach\n`;
    p += `2. Break the problem into smaller steps\n`;
    p += `3. Read error messages more carefully\n`;
    p += `4. If truly blocked: <done>STUCK: [reason]</done>\n\n`;
  }
  
  p += `## Rules\n`;
  p += `- When task is COMPLETE, output exactly: <done>${state.promise}</done>\n`;
  p += `- If stuck, output: <done>STUCK: [reason]</done>\n`;
  p += `- Focus on one step at a time\n`;
  p += `- Test your changes\n`;
  
  return p;
}

// --- Shared ---
function loadOrDie(id) {
  const path = statePath(id);
  if (!existsSync(path)) {
    console.error(`❌ Loop not found: ${id}`);
    process.exit(1);
  }
  const state = readJson(path);
  if (!state) {
    console.error(`❌ Corrupted state: ${id}`);
    process.exit(1);
  }
  return state;
}

function save(state) {
  ensureDir(MISSIONS_DIR);
  state.updatedAt = new Date().toISOString();
  writeJson(statePath(state.id), state);
}

// --- Main ---
const [,, cmd, ...args] = process.argv;

const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
    flags[key] = val;
    if (val !== true) i++;
  }
}

try {
  switch (cmd) {
    case 'init':
      if (!flags.task || !flags.dir) {
        console.error('Usage: node mula-ralph.mjs init --task "..." --dir /path [--max-iterations 30] [--model ...]');
        process.exit(1);
      }
      cmdInit(flags.task, flags.dir, {
        maxIterations: flags['max-iterations'],
        model: flags.model,
        promise: flags.promise
      });
      break;
    case 'iterate':
      if (!flags.id) { console.error('Need --id'); process.exit(1); }
      cmdIterate(flags.id, flags.output || '');
      break;
    case 'check':
      cmdCheck(flags.id);
      break;
    case 'resume':
      if (!flags.id) { console.error('Need --id'); process.exit(1); }
      cmdResume(flags.id);
      break;
    case 'done':
      if (!flags.id) { console.error('Need --id'); process.exit(1); }
      cmdTerminate(flags.id, 'done', flags.reason);
      break;
    case 'fail':
      if (!flags.id) { console.error('Need --id'); process.exit(1); }
      cmdTerminate(flags.id, 'error', flags.reason);
      break;
    case 'cancel':
      if (!flags.id) { console.error('Need --id'); process.exit(1); }
      cmdTerminate(flags.id, 'cancelled', flags.reason || 'User cancelled');
      break;
    case 'status':
      if (!flags.id) { console.error('Need --id'); process.exit(1); }
      cmdStatus(flags.id);
      break;
    case 'list':
      cmdList();
      break;
    default:
      console.log('mula-ralph — Self-driving loop state manager for OpenClaw');
      console.log('');
      console.log('Commands:');
      console.log('  init      Create new loop          --task "..." --dir /path [--max-iterations 30]');
      console.log('  iterate   Record iteration result   --id <id> --output "agent output..."');
      console.log('  check     Check state (JSON)        [--id <id>]  (no id = list running)');
      console.log('  resume    Resume paused loop         --id <id>');
      console.log('  done      Mark complete              --id <id> [--reason "..."]');
      console.log('  fail      Mark failed                --id <id> --reason "..."');
      console.log('  cancel    Cancel loop                --id <id>');
      console.log('  status    Human-readable status      --id <id>');
      console.log('  list      List all loops');
  }
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
}
