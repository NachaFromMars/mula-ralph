# mula-ralph — Self-driving agent loop that runs until done

> Spawn, poll, check, repeat — until the task is complete. mula-ralph handles stuck detection, circuit breaking, and auto-resume so you don't have to babysit long-running autonomous jobs.

[![OpenClaw Skill](https://img.shields.io/badge/OpenClaw-Skill-blueviolet)](https://github.com/NachaFromMars)

## Overview
mula-ralph is a self-driving agent loop managed by `mula-ralph.mjs`. The agent spawns a sub-agent with a prompt, collects the output, feeds it to the script for analysis, and spawns again with a refined prompt if the task is unfinished. The script handles promise detection (`<done>COMPLETE</done>`), stuck detection (3 identical outputs → inject warning), circuit breaking (5 identical outputs → force exit), and gateway-restart recovery (auto-resume up to 3 times). Fork of Ralph Loop (Anthropic + frankbria, MIT).

## Features
- **Autonomous loop** — spawn → collect → check → spawn again
- **Promise detection** — stops on `<done>COMPLETE</done>` signal
- **Stuck detection** — 3 identical outputs → inject stuck warning prompt
- **Circuit breaker** — 5 identical outputs → force exit
- **Auto-resume** — gateway restart → heartbeat resumes (max 3×)
- **State managed** by `mula-ralph.mjs`

## When to Use
✅ Build feature autonomously (no human input per step) | ✅ Large task needing many iterations
❌ Simple one-liners | ❌ Tasks requiring human decision at each step

## Trigger Keywords (OpenClaw)
ralph loop, mula-ralph, self-driving, autonomous loop, auto code, loop task

## Related Skills
- [mula-forge-code](https://github.com/NachaFromMars/mula-forge-code) — structured pipeline (human gates per phase)

---
Part of the [NachaFromMars](https://github.com/NachaFromMars) OpenClaw skill ecosystem.
