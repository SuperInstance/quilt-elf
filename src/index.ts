/**
 * @quilt/elf — invisible elves doing background housekeeping.
 *
 * 5 components:
 *   1. ContextManager   — the brain, tracks user activity + vibe
 *   2. ResourceTracker  — the wallet, tracks per-provider usage
 *   3. Backlog          — the queue, holds pending tasks
 *   4. Dispatcher       — the worker, routes tasks to providers
 *   5. AuditLoop        — the eye, finds improvement opportunities
 *
 * Together they form a self-improving system that:
 *   - Accelerates when free tokens are about to reset
 *   - Throttles when the user is busy
 *   - Targets the lowest-scoring skills during idle time
 *
 * See README.md for the architecture diagram.
 */

// ──────────────────────────────────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────────────────────────────────

/** The current system vibe — drives behavior. */
export type Vibe =
  | 'USER_BUSY'      // User is actively coding
  | 'USER_IDLE'      // System is idle
  | 'FLUSH_MODE'     // Within 2h of daily reset
  | 'SELF_IMPROVE'   // Long idle, target weaknesses
  | 'ONBOARDING';    // First session

/** Provider tier — free tier, subscription, or metered. */
export type ProviderTier = 'free' | 'subscription' | 'metered';

/** Provider configuration. */
export interface ProviderConfig {
  apiKey: string;
  tier: ProviderTier;
  /** Reset hour in UTC (default 0 for free tier). */
  resetHourUtc?: number;
  /** Daily free quota (estimated; -1 = unknown). */
  dailyFreeQuota?: number;
  /** Specialty for routing. */
  specialty?: 'high-concurrency' | 'math' | 'niche' | 'general';
}

/** A pending task in the backlog. */
export interface BacklogTask {
  id: string;
  kind: 'simulation' | 'example-generation' | 'self-improve' | 'audit' | 'docs' | 'test';
  priority: number;  // higher = more important
  payload: Record<string, unknown>;
  createdAt: number;
  /** Estimated tokens required. */
  estimatedTokens?: number;
  /** Which provider this prefers. */
  preferredProvider?: keyof Providers;
  /** Vibe(s) during which this task should run. */
  allowedVibes: Vibe[];
}

/** Result of a completed task. */
export interface TaskResult {
  taskId: string;
  status: 'success' | 'error' | 'skipped';
  output?: unknown;
  error?: string;
  provider?: keyof Providers;
  tokensUsed?: number;
  durationMs: number;
  startedAt: number;
  finishedAt: number;
}

/** Provider registry. */
export interface Providers {
  zai?: ProviderConfig;
  kimi?: ProviderConfig;
  deepseek?: ProviderConfig;
  cloudflare?: ProviderConfig;
}

/** Configuration for the Elf. */
export interface ElfConfig {
  providers: Providers;
  vibe?: Vibe | 'auto';
  /** Cron interval in seconds (default 300 = 5min). */
  intervalSeconds?: number;
  /** Maximum concurrent tasks (default 5). */
  maxConcurrent?: number;
  /** Storage for the resource tracker (KV/Durable Object/in-memory). */
  storage?: ResourceStorage;
  /** Custom logger. */
  log?: (msg: string, level?: 'info' | 'warn' | 'error' | 'debug') => void;
  /** Custom user activity tracker. */
  userActivity?: UserActivityTracker;
}

export interface UserActivityTracker {
  /** Returns the number of seconds since the user's last action. */
  secondsSinceLastAction(): Promise<number>;
  /** Mark an action (called by the user's IDE/app). */
  markAction(): Promise<void>;
}

export interface ResourceStorage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────────
//  1. Context Manager
// ──────────────────────────────────────────────────────────────────────────

export class ContextManager {
  private currentVibe: Vibe;
  private lastVibeChange: number;
  private activityTracker?: UserActivityTracker;

  constructor(initialVibe: Vibe = 'USER_IDLE', activityTracker?: UserActivityTracker) {
    this.currentVibe = initialVibe;
    this.lastVibeChange = Date.now();
    this.activityTracker = activityTracker;
  }

  /** Detect the current vibe based on user activity and time. */
  async detectVibe(): Promise<Vibe> {
    // Check if we're within 2h of any provider's daily reset
    if (this.isFlushWindow()) {
      this.setVibe('FLUSH_MODE');
      return this.currentVibe;
    }

    // Check user activity
    if (this.activityTracker) {
      const idleSeconds = await this.activityTracker.secondsSinceLastAction();
      if (idleSeconds < 30) {
        this.setVibe('USER_BUSY');
        return this.currentVibe;
      }
      if (idleSeconds > 600) {  // 10 min
        this.setVibe('SELF_IMPROVE');
        return this.currentVibe;
      }
    }

    this.setVibe('USER_IDLE');
    return this.currentVibe;
  }

  /** Check if we're within 2 hours of any provider's daily reset. */
  private isFlushWindow(): boolean {
    const now = new Date();
    const utcHour = now.getUTCHours();
    // Most free tier resets are at 00:00 UTC
    // Flush window: 22:00-00:00 UTC
    return utcHour >= 22 || utcHour === 0;
  }

  /**
   * Compute a 'vibe score' that quantifies how aggressive the system
   * should be in spending free tokens.
   *
   * Per Kimi's recommendation (moonshot-v1-8k):
   *   score = 0.4 * time_factor + 0.3 * user_factor + 0.2 * backlog_factor + 0.1 * token_factor
   *
   * Each factor is 0-1. The score is 0-1. Higher = more aggressive.
   */
  async computeVibeScore(opts: {
    backlogSize?: number;
    freeTokensRemaining?: number;
    maxFreeTokens?: number;
  } = {}): Promise<number> {
    const time = this.timeFactor();
    const user = await this.userFactor();
    const backlog = this.backlogFactor(opts.backlogSize ?? 0);
    const tokens = this.tokenFactor(opts.freeTokensRemaining ?? 0, opts.maxFreeTokens ?? 1);
    return 0.4 * time + 0.3 * user + 0.2 * backlog + 0.1 * tokens;
  }

  /** Time factor: 1 at 22:00 UTC, 0 at 00:00 UTC. */
  private timeFactor(): number {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    const minutesSinceFlushStart = (utcHour - 22 + 24) % 24 * 60 + utcMin;
    const flushWindowMinutes = 2 * 60;  // 2 hours
    if (minutesSinceFlushStart > flushWindowMinutes) return 0;
    return 1 - minutesSinceFlushStart / flushWindowMinutes;
  }

  /** User factor: 1 when idle, 0 when active. */
  private async userFactor(): Promise<number> {
    if (!this.activityTracker) return 0.5;  // unknown → moderate
    const idleSec = await this.activityTracker.secondsSinceLastAction();
    if (idleSec > 600) return 1.0;
    if (idleSec > 60) return 0.5;
    if (idleSec > 30) return 0.2;
    return 0;
  }

  /** Backlog factor: scales with backlog size. */
  private backlogFactor(size: number): number {
    return Math.min(1, size / 50);
  }

  /** Token factor: 1 when tokens are fresh, 0 when exhausted. */
  private tokenFactor(remaining: number, max: number): number {
    if (max <= 0) return 0;
    return Math.min(1, remaining / max);
  }

  /** Manually set the vibe. */
  setVibe(vibe: Vibe): void {
    if (vibe !== this.currentVibe) {
      this.lastVibeChange = Date.now();
      this.currentVibe = vibe;
    }
  }

  /** Get the current vibe. */
  getVibe(): Vibe { return this.currentVibe; }

  /** Get time since last vibe change. */
  timeSinceVibeChange(): number { return Date.now() - this.lastVibeChange; }
}

// ──────────────────────────────────────────────────────────────────────────
//  2. Resource Tracker
// ──────────────────────────────────────────────────────────────────────────

export interface ProviderUsage {
  provider: keyof Providers;
  usedToday: number;        // tokens used today
  freeQuota: number;        // estimated free quota
  resetAt: number;          // ms timestamp of next reset
  isFree: boolean;
  isAvailable: boolean;     // false if quota exhausted
  cheapWindow: boolean;     // true if within 2h of reset
}

export class ResourceTracker {
  private usage = new Map<keyof Providers, ProviderUsage>();
  private providers: Providers;
  private storage?: ResourceStorage;

  constructor(providers: Providers, storage?: ResourceStorage) {
    this.providers = providers;
    this.storage = storage;
  }

  /** Get usage for a provider. */
  async getUsage(provider: keyof Providers): Promise<ProviderUsage | undefined> {
    return this.usage.get(provider);
  }

  /** Get all providers sorted by availability. */
  async getAvailable(): Promise<ProviderUsage[]> {
    return Array.from(this.usage.values())
      .filter((u) => u.isAvailable)
      .sort((a, b) => {
        if (a.cheapWindow && !b.cheapWindow) return -1;
        if (!a.cheapWindow && b.cheapWindow) return 1;
        return (b.freeQuota - b.usedToday) - (a.freeQuota - a.usedToday);
      });
  }

  /** Record token usage for a provider. */
  async recordUsage(provider: keyof Providers, tokens: number): Promise<void> {
    const current = this.usage.get(provider);
    if (current) {
      current.usedToday += tokens;
      current.isAvailable = current.usedToday < current.freeQuota;
    }
    if (this.storage) {
      await this.storage.put(`usage:${provider}:${this.todayKey()}`, String(this.usage.get(provider)?.usedToday ?? 0));
    }
  }

  /** Refresh all usage from storage / compute fresh. */
  async refresh(): Promise<void> {
    for (const [name, config] of Object.entries(this.providers)) {
      if (!config) continue;
      const providerName = name as keyof Providers;
      const resetAt = this.computeResetAt(config.resetHourUtc ?? 0);
      const isFree = config.tier === 'free';
      let usedToday = 0;
      if (this.storage) {
        const stored = await this.storage.get(`usage:${providerName}:${this.todayKey()}`);
        if (stored) usedToday = parseInt(stored, 10);
      }
      const freeQuota = config.dailyFreeQuota ?? 100000;
      this.usage.set(providerName, {
        provider: providerName,
        usedToday,
        freeQuota,
        resetAt,
        isFree,
        isAvailable: usedToday < freeQuota,
        cheapWindow: this.isWithinHoursOfReset(resetAt, 2),
      });
    }
  }

  /** Today key in YYYY-MM-DD format. */
  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Compute the next reset timestamp. */
  private computeResetAt(resetHourUtc: number): number {
    const now = new Date();
    const next = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      resetHourUtc, 0, 0,
    ));
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime();
  }

  /** Check if a reset is within the next N hours. */
  private isWithinHoursOfReset(resetAt: number, hours: number): boolean {
    return resetAt - Date.now() < hours * 60 * 60 * 1000;
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  3. Backlog
// ──────────────────────────────────────────────────────────────────────────

export class Backlog {
  private tasks: BacklogTask[] = [];

  add(task: BacklogTask): void {
    this.tasks.push(task);
  }

  remove(id: string): boolean {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i >= 0) {
      this.tasks.splice(i, 1);
      return true;
    }
    return false;
  }

  /** Peek at the next task, considering vibe. */
  peek(vibe: Vibe): BacklogTask | undefined {
    const allowed = this.tasks
      .filter((t) => t.allowedVibes.includes(vibe))
      .sort((a, b) => b.priority - a.priority);
    return allowed[0];
  }

  /** Pop the next task. */
  pop(vibe: Vibe): BacklogTask | undefined {
    const task = this.peek(vibe);
    if (task) this.remove(task.id);
    return task;
  }

  size(): number { return this.tasks.length; }
  all(): BacklogTask[] { return [...this.tasks]; }
  clear(): void { this.tasks = []; }
}

// ──────────────────────────────────────────────────────────────────────────
//  4. Dispatcher
// ──────────────────────────────────────────────────────────────────────────

export interface DispatcherOptions {
  providers: Providers;
  resourceTracker: ResourceTracker;
  log?: (msg: string, level?: 'info' | 'warn' | 'error' | 'debug') => void;
}

interface LLMCaller {
  call(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<{ text: string; tokensUsed?: number }>;
}

export class Dispatcher {
  private providers: Providers;
  private resourceTracker: ResourceTracker;
  private log?: DispatcherOptions['log'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private callers: Map<keyof Providers, LLMCaller> = new Map();

  constructor(opts: DispatcherOptions) {
    this.providers = opts.providers;
    this.resourceTracker = opts.resourceTracker;
    this.log = opts.log;
    this.registerDefaultCallers();
  }

  /** Dispatch a task to the appropriate provider. */
  async dispatch(task: BacklogTask): Promise<TaskResult> {
    const startedAt = Date.now();
    const provider = await this.chooseProvider(task);
    if (!provider) {
      return {
        taskId: task.id,
        status: 'skipped',
        error: 'No available provider',
        durationMs: 0,
        startedAt,
        finishedAt: Date.now(),
      };
    }
    const caller = this.callers.get(provider);
    if (!caller) {
      return {
        taskId: task.id,
        status: 'skipped',
        error: `No caller for ${provider}`,
        durationMs: 0,
        startedAt,
        finishedAt: Date.now(),
      };
    }
    try {
      const prompt = this.taskToPrompt(task);
      const out = await caller.call(prompt, { maxTokens: task.estimatedTokens ?? 1024 });
      if (out.tokensUsed) {
        await this.resourceTracker.recordUsage(provider, out.tokensUsed);
      }
      return {
        taskId: task.id,
        status: 'success',
        output: out.text,
        provider,
        tokensUsed: out.tokensUsed,
        durationMs: Date.now() - startedAt,
        startedAt,
        finishedAt: Date.now(),
      };
    } catch (e) {
      return {
        taskId: task.id,
        status: 'error',
        error: (e as Error).message,
        provider,
        durationMs: Date.now() - startedAt,
        startedAt,
        finishedAt: Date.now(),
      };
    }
  }

  /** Choose the best provider for a task. */
  private async chooseProvider(task: BacklogTask): Promise<keyof Providers | undefined> {
    // 1. If task prefers a specific provider and it's available
    if (task.preferredProvider) {
      const usage = await this.resourceTracker.getUsage(task.preferredProvider);
      if (usage?.isAvailable) return task.preferredProvider;
    }
    // 2. Match by task kind
    if (task.kind === 'simulation' || task.kind === 'example-generation') {
      // High concurrency → z.ai
      const zai = await this.resourceTracker.getUsage('zai');
      if (zai?.isAvailable) return 'zai';
    }
    if (task.kind === 'self-improve' || task.kind === 'audit') {
      // Hard math/reasoning → Kimi
      const kimi = await this.resourceTracker.getUsage('kimi');
      if (kimi?.isAvailable) return 'kimi';
    }
    // 3. Fall back to cheapest available
    const available = await this.resourceTracker.getAvailable();
    return available[0]?.provider;
  }

  /** Convert a task to a prompt. */
  private taskToPrompt(task: BacklogTask): string {
    return JSON.stringify(task.payload);
  }

  /** Register default HTTP-based callers. */
  private registerDefaultCallers(): void {
    if (this.providers.zai?.apiKey) {
      this.callers.set('zai', makeZaiCaller(this.providers.zai.apiKey, this.providers.zai.specialty));
    }
    if (this.providers.kimi?.apiKey) {
      this.callers.set('kimi', makeKimiCaller(this.providers.kimi.apiKey));
    }
    if (this.providers.deepseek?.apiKey) {
      this.callers.set('deepseek', makeDeepSeekCaller(this.providers.deepseek.apiKey));
    }
    if (this.providers.cloudflare) {
      this.callers.set('cloudflare', makeCloudflareCaller(this.providers.cloudflare.apiKey));
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  Caller factories
// ──────────────────────────────────────────────────────────────────────────

function makeZaiCaller(apiKey: string, specialty?: string): LLMCaller {
  return {
    async call(prompt: string, options) {
      const model = specialty === 'math' ? 'glm-4.5' : 'glm-4.5';
      const res = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: options?.maxTokens ?? 1024,
          temperature: options?.temperature ?? 0.3,
        }),
      });
      if (!res.ok) throw new Error(`z.ai failed: ${res.status}`);
      const j = await res.json() as { choices: Array<{ message: { content: string } }>; usage?: { total_tokens: number } };
      return { text: j.choices[0]?.message.content ?? '', tokensUsed: j.usage?.total_tokens };
    },
  };
}

function makeKimiCaller(apiKey: string): LLMCaller {
  return {
    async call(prompt: string, options) {
      const res = await fetch('https://api.moonshot.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshot-v1-8k',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: options?.maxTokens ?? 1024,
          temperature: options?.temperature ?? 0.3,
        }),
      });
      if (!res.ok) throw new Error(`Kimi failed: ${res.status}`);
      const j = await res.json() as { choices: Array<{ message: { content: string } }>; usage?: { total_tokens: number } };
      return { text: j.choices[0]?.message.content ?? '', tokensUsed: j.usage?.total_tokens };
    },
  };
}

function makeDeepSeekCaller(apiKey: string): LLMCaller {
  return {
    async call(prompt: string, options) {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: options?.maxTokens ?? 1024,
          temperature: options?.temperature ?? 0.3,
        }),
      });
      if (!res.ok) throw new Error(`DeepSeek failed: ${res.status}`);
      const j = await res.json() as { choices: Array<{ message: { content: string } }>; usage?: { total_tokens: number } };
      return { text: j.choices[0]?.message.content ?? '', tokensUsed: j.usage?.total_tokens };
    },
  };
}

function makeCloudflareCaller(apiKey: string): LLMCaller {
  // Cloudflare AI uses accountId + token, not just apiKey.
  // The apiKey is expected to be in the format "accountId:token"
  const [accountId, token] = apiKey.split(':');
  return {
    async call(prompt: string, options) {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: prompt }],
            max_tokens: options?.maxTokens ?? 1024,
          }),
        }
      );
      if (!res.ok) throw new Error(`Cloudflare AI failed: ${res.status}`);
      const j = await res.json() as { result: { response: string } };
      return { text: j.result.response };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  5. Audit Loop
// ──────────────────────────────────────────────────────────────────────────

export interface SkillScore {
  skillId: string;
  score: number;       // 0-1
  attempts: number;
  lastUpdated: number;
}

export interface AuditLoopOptions {
  backlog: Backlog;
  log?: (msg: string, level?: 'info' | 'warn' | 'error' | 'debug') => void;
  /** Get current skill scores. */
  getScores?: () => Promise<SkillScore[]>;
  /** Set skill scores. */
  setScores?: (scores: SkillScore[]) => Promise<void>;
}

export class AuditLoop {
  private backlog: Backlog;
  private log?: AuditLoopOptions['log'];
  private getScores?: AuditLoopOptions['getScores'];
  private setScores?: AuditLoopOptions['setScores'];

  constructor(opts: AuditLoopOptions) {
    this.backlog = opts.backlog;
    this.log = opts.log;
    this.getScores = opts.getScores;
    this.setScores = opts.setScores;
  }

  /** Run an audit cycle: identify low-hanging fruit, push to backlog. */
  async runAudit(): Promise<BacklogTask[]> {
    const scores = (await this.getScores?.()) ?? [];
    const lowScoring = scores
      .filter((s) => s.score < 0.7)
      .sort((a, b) => a.score - b.score)
      .slice(0, 3);

    const newTasks: BacklogTask[] = [];

    for (const skill of lowScoring) {
      const task: BacklogTask = {
        id: `improve:${skill.skillId}:${Date.now()}`,
        kind: 'self-improve',
        priority: Math.round((1 - skill.score) * 100),
        payload: {
          action: 'improve-skill',
          skillId: skill.skillId,
          currentScore: skill.score,
          attempts: skill.attempts,
        },
        createdAt: Date.now(),
        estimatedTokens: 2000,
        preferredProvider: 'kimi',
        allowedVibes: ['USER_IDLE', 'FLUSH_MODE', 'SELF_IMPROVE'],
      };
      this.backlog.add(task);
      newTasks.push(task);
    }

    // Add a "generate examples" task for the worst-scoring skill
    if (lowScoring[0]) {
      const task: BacklogTask = {
        id: `examples:${lowScoring[0].skillId}:${Date.now()}`,
        kind: 'example-generation',
        priority: 50,
        payload: {
          action: 'generate-examples',
          skillId: lowScoring[0].skillId,
          count: 10,
        },
        createdAt: Date.now(),
        estimatedTokens: 3000,
        preferredProvider: 'zai',
        allowedVibes: ['FLUSH_MODE', 'SELF_IMPROVE'],
      };
      this.backlog.add(task);
      newTasks.push(task);
    }

    this.log?.(`Audit complete: ${newTasks.length} new tasks, ${lowScoring.length} low-scoring skills`, 'info');
    return newTasks;
  }

  /** Update a skill's score after a run. */
  async updateScore(skillId: string, newScore: number): Promise<void> {
    if (!this.getScores || !this.setScores) return;
    const scores = await this.getScores();
    const existing = scores.find((s) => s.skillId === skillId);
    if (existing) {
      existing.score = (existing.score * existing.attempts + newScore) / (existing.attempts + 1);
      existing.attempts += 1;
      existing.lastUpdated = Date.now();
    } else {
      scores.push({ skillId, score: newScore, attempts: 1, lastUpdated: Date.now() });
    }
    await this.setScores(scores);
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  The Elf — wires it all together
// ──────────────────────────────────────────────────────────────────────────

export class Elf {
  private config: Required<Omit<ElfConfig, 'storage' | 'log' | 'userActivity' | 'vibe' | 'intervalSeconds' | 'maxConcurrent'>>;
  private storage?: ResourceStorage;
  private log: ElfConfig['log'];
  private userActivity?: UserActivityTracker;
  private contextManager: ContextManager;
  private resourceTracker: ResourceTracker;
  private backlog: Backlog;
  private dispatcher: Dispatcher;
  private auditLoop: AuditLoop;
  private vibe: Vibe | 'auto';
  private maxConcurrent: number;

  constructor(config: ElfConfig) {
    this.config = {
      providers: config.providers,
    } as any;
    this.storage = config.storage;
    this.log = config.log ?? (() => {});
    this.userActivity = config.userActivity;
    this.vibe = config.vibe ?? 'auto';
    this.maxConcurrent = config.maxConcurrent ?? 5;

    this.contextManager = new ContextManager('USER_IDLE', this.userActivity);
    this.resourceTracker = new ResourceTracker(config.providers, this.storage);
    this.backlog = new Backlog();
    this.dispatcher = new Dispatcher({
      providers: config.providers,
      resourceTracker: this.resourceTracker,
      log: this.log,
    });
    this.auditLoop = new AuditLoop({
      backlog: this.backlog,
      log: this.log,
    });
  }

  /** Run one cycle: detect vibe, refresh resources, audit, dispatch. */
  async run(): Promise<TaskResult[]> {
    // 1. Detect vibe
    const vibe = this.vibe === 'auto' ? await this.contextManager.detectVibe() : this.vibe;
    this.log?.(`Vibe: ${vibe}`, 'info');

    // 2. Refresh resource tracking
    await this.resourceTracker.refresh();

    // 3. Run audit (only when idle or self-improve)
    if (vibe === 'USER_IDLE' || vibe === 'SELF_IMPROVE' || vibe === 'FLUSH_MODE') {
      await this.auditLoop.runAudit();
    }

    // 4. Dispatch tasks
    const results: TaskResult[] = [];
    const inFlight: Promise<void>[] = [];
    for (let i = 0; i < this.maxConcurrent; i++) {
      const task = this.backlog.pop(vibe);
      if (!task) break;
      // Don't dispatch heavy work when user is busy
      if (vibe === 'USER_BUSY' && task.kind === 'self-improve') {
        // Put it back
        this.backlog.add(task);
        continue;
      }
      const promise = this.dispatcher.dispatch(task).then((r) => {
        results.push(r);
        // If skipped (no provider), put the task back
        if (r.status === 'skipped') this.backlog.add(task);
      });
      inFlight.push(promise);
    }
    await Promise.all(inFlight);

    this.log?.(`Cycle complete: ${results.length} tasks dispatched`, 'info');
    return results;
  }

  /** Get the current vibe. */
  getVibe(): Vibe { return this.contextManager.getVibe(); }

  /** Manually set the vibe (overrides auto-detection for future run() calls). */
  setVibe(vibe: Vibe): void {
    this.contextManager.setVibe(vibe);
    this.vibe = vibe;
  }

  /** Get current usage report. */
  async getUsageReport(): Promise<ProviderUsage[]> {
    return this.resourceTracker.getAvailable();
  }

  /** Get current backlog size. */
  backlogSize(): number { return this.backlog.size(); }

  /** Manually add a task to the backlog. */
  addTask(task: BacklogTask): void { this.backlog.add(task); }

  /** Get the components (for advanced usage). */
  get components() {
    return {
      contextManager: this.contextManager,
      resourceTracker: this.resourceTracker,
      backlog: this.backlog,
      dispatcher: this.dispatcher,
      auditLoop: this.auditLoop,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  Cloudflare Worker entry point
// ──────────────────────────────────────────────────────────────────────────

/**
 * Default Cloudflare Worker handler.
 *
 * Bind this in your wrangler.toml:
 *   [env.production]
 *   ZAI_TOKEN = "..."
 *   KIMI_TOKEN = "..."
 *   DEEPSEEK_TOKEN = "..."
 *
 * Then set up a cron trigger:
 *   [triggers]
 *   crons = ["*\\/5 * * * *"]  # every 5 minutes (asterisk-slash-five)
 */
export interface ElfEnv {
  ZAI_TOKEN?: string;
  KIMI_TOKEN?: string;
  DEEPSEEK_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export function makeWorkerHandler(log?: (msg: string) => void) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async scheduled(event: any, env: any, ctx: any) {
      const elf = new Elf({
        providers: {
          zai: env.ZAI_TOKEN ? { apiKey: env.ZAI_TOKEN, tier: 'free', dailyFreeQuota: 100000, specialty: 'high-concurrency' } : undefined,
          kimi: env.KIMI_TOKEN ? { apiKey: env.KIMI_TOKEN, tier: 'free', dailyFreeQuota: 100000, specialty: 'math' } : undefined,
          deepseek: env.DEEPSEEK_TOKEN ? { apiKey: env.DEEPSEEK_TOKEN, tier: 'metered', specialty: 'niche' } : undefined,
          cloudflare: env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN
            ? { apiKey: `${env.CLOUDFLARE_ACCOUNT_ID}:${env.CLOUDFLARE_API_TOKEN}`, tier: 'free' }
            : undefined,
        },
        log: log ?? ((msg) => console.log(`[elf] ${msg}`)),
        storage: {
          async get(key: string) { return null; },  // in-memory; replace with KV/D1
          async put(key: string, value: string) {},
          async delete(key: string) {},
        },
      });

      ctx.waitUntil(elf.run());
    },
  };
}
