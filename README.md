# 🧝 quilt-elf

> **The invisible elves.** Cloudflare Workers running as background housekeeping — accelerating when free tokens are about to reset, throttling when the user is busy, identifying low-hanging fruit for self-improvement.

```
 ██████╗ ██╗   ██╗██╗██╗     ████████╗      ███████╗██╗     ███████╗
██╔═══██╗██║   ██║██║██║     ╚══██╔══╝      ██╔════╝██║     ██╔════╝
██║   ██║██║   ██║██║██║        ██║   █████╗█████╗  ██║     █████╗
██║▄▄ ██║██║   ██║██║██║        ██║   ╚════╝██╔══╝  ██║     ██╔══╝
╚██████╔╝╚██████╔╝██║███████╗   ██║         ██║     ███████╗███████╗
 ╚══▀▀═╝  ╚═════╝ ╚═╝╚══════╝   ╚═╝         ╚═╝     ╚══════╝╚══════╝

  invisible · daily-limit-aware · self-improving
```

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![typescript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)
[![node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](./package.json)
[![version](https://img.shields.io/badge/version-0.1.0-orange.svg)](./package.json)

---

## ✦ What is `quilt-elf`?

The invisible elves are Cloudflare Workers running in the background, doing housekeeping that makes the whole Quilt ecosystem smarter. They accelerate when free LLM tokens are about to be wasted (just before daily reset), throttle down when you're actively coding, and constantly look for the lowest-hanging fruit for self-improvement.

**The key insight:** the daily reset for free-tier LLM providers is the same time every day (typically 00:00 UTC). Free tokens that aren't used by the reset are wasted. So the system should be smart about WHEN it spends those tokens — accelerating background work in the last hour or two before reset, throttling down when the user is busy.

## ✦ The 5 components

```
   ┌──────────────────────────────────────────────────┐
   │  Context Manager (the brain)                     │
   │  tracks: user activity, current time, vibe      │
   └────────────────┬─────────────────────────────────┘
                    │
   ┌────────────────▼─────────────────────────────────┐
   │  Resource Tracker (the wallet)                  │
   │  tracks: per-provider usage, free quota, resets │
   └────────────────┬─────────────────────────────────┘
                    │
   ┌────────────────▼─────────────────────────────────┐
   │  Backlog (the queue)                            │
   │  tasks: simulations, examples, self-improve     │
   │  reorders based on vibe                         │
   └────────────────┬─────────────────────────────────┘
                    │
   ┌────────────────▼─────────────────────────────────┐
   │  Dispatcher (the worker)                        │
   │  routes: z.ai (high-concurrency), Kimi (math),  │
   │  DeepSeek (niche), Cloudflare AI (fallback)     │
   └────────────────┬─────────────────────────────────┘
                    │
   ┌────────────────▼─────────────────────────────────┐
   │  Audit Loop (the brain-feeding eye)             │
   │  finds: low-scoring skills, simulation gaps,    │
   │  generates tasks, pushes to Backlog             │
   └──────────────────────────────────────────────────┘
```

### 1. Context Manager
Monitors user activity and current time. Determines the current **vibe**:
- `USER_BUSY` — user is actively coding; save tokens for them
- `USER_IDLE` — system is idle; run background simulations
- `FLUSH_MODE` — within 2 hours of daily reset; maximize token usage
- `SELF_IMPROVE` — long idle period; target lowest-scoring skills
- `ONBOARDING` — first session; prioritize parallel work via z.ai

### 2. Resource Tracker
Maintains a real-time ledger of:
- API usage per provider (z.ai, Kimi, DeepSeek, Cloudflare AI)
- Daily/monthly free quotas
- Reset times (typically 00:00 UTC)
- Cost tier (free / metered / subscription)
- "Cheap window" detection: when a provider has free tokens that will reset soon

### 3. Backlog
Priority queue of background tasks:
- Run simulations on open questions
- Generate training examples for low-scoring skills
- Test the system against new edge cases
- Improve documentation
- Audit and fix code

The backlog reorders based on the current vibe. During `USER_BUSY`, user-facing tasks jump to the front. During `FLUSH_MODE`, low-priority "self-improve" tasks are elevated.

### 4. Dispatcher
Routes tasks to providers based on capability and cost:
- **z.ai (GLM-4.5)** — high-concurrency parallel work
- **Kimi (moonshot-v1-8k)** — hard math, careful reasoning
- **DeepSeek (V3 Flash)** — niche expertise, scouting
- **Cloudflare AI** — fallback, low cost

Before sending, it checks the Resource Tracker for available quota. Falls back to Cloudflare AI if the preferred provider is throttled.

### 5. Audit Loop
Identifies "low-hanging fruit" for self-improvement:
- Scans skill scores and finds underperformers
- Generates specific tasks: "Generate 10 test cases for Skill X"
- Pushes tasks to the Backlog
- The system continuously targets its weakest areas during idle windows

## ✦ The "invisible elves" pattern

The whole thing runs as a Cloudflare Worker on a cron trigger (every 5 minutes by default). The user never sees it running. But the system is constantly:

1. **Identifying what to work on** (Audit Loop)
2. **Choosing when to work on it** (Context Manager + Resource Tracker)
3. **Routing to the right provider** (Dispatcher)
4. **Storing the results** (Backlog → Quilt cells)

The user only sees the results: better skills, more examples, cleaner docs, faster responses. The elves do the work invisibly.

## ✦ Installation

```bash
npm install @quilt/elf
```

## ✦ Quick start

```ts
import { Elf, ContextManager, ResourceTracker, Backlog, Dispatcher, AuditLoop } from '@quilt/elf';

const elf = new Elf({
  providers: {
    zai: { apiKey: process.env.ZAI_TOKEN, tier: 'free' },
    kimi: { apiKey: process.env.KIMI_TOKEN, tier: 'free' },
    deepseek: { apiKey: process.env.DEEPSEEK_TOKEN, tier: 'metered' },
  },
  vibe: 'auto',  // auto-detect based on activity
});

await elf.run();  // runs the full cycle
```

## ✦ The Quilt ecosystem

`quilt-elf` is one of 19 Quilt repos. The elves use:

- `@quilt/core` — the cell runtime
- `@quilt/ai` — LLM cells (z.ai, Kimi, DeepSeek)
- `@quilt/sdk` — publish results as artifacts
- `@quilt/evolve` — RLAIF (Reinforcement Learning from AI Feedback)
- `@quilt/fleet` — orchestrate elves across tiers

The elves are the **always-on layer** of the system. Other repos are the **user-facing layer**.

## ✦ License

Apache 2.0. See [LICENSE](./LICENSE).
