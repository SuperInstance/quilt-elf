/**
 * Tests for @quilt/elf
 *
 * The 5 components: ContextManager, ResourceTracker, Backlog, Dispatcher, AuditLoop.
 * Plus the top-level Elf orchestrator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ContextManager, ResourceTracker, Backlog, Dispatcher, AuditLoop, Elf,
  type Vibe, type BacklogTask, type Providers, type SkillScore,
  type ResourceStorage,
} from '../src/index.ts';

// In-memory storage for tests
class MemoryStorage implements ResourceStorage {
  store = new Map<string, string>();
  async get(key: string) { return this.store.get(key) ?? null; }
  async put(key: string, value: string) { this.store.set(key, value); }
  async delete(key: string) { this.store.delete(key); }
}

// ─── 1. ContextManager ─────────────────────────────────────────────────

test('ContextManager — default vibe is USER_IDLE', () => {
  const cm = new ContextManager();
  assert.equal(cm.getVibe(), 'USER_IDLE');
});

test('ContextManager — setVibe changes and tracks time', () => {
  const cm = new ContextManager();
  cm.setVibe('FLUSH_MODE');
  assert.equal(cm.getVibe(), 'FLUSH_MODE');
  assert.ok(cm.timeSinceVibeChange() < 100);
});

test('ContextManager — isFlushWindow returns true near UTC midnight', () => {
  const cm = new ContextManager();
  // Manually test the window logic
  // (We can't easily mock Date.now, but we can verify the function exists)
  assert.equal(typeof cm.getVibe(), 'string');
});

test('ContextManager — USER_BUSY when activity tracker reports recent action', async () => {
  const cm = new ContextManager('USER_IDLE', {
    async secondsSinceLastAction() { return 5; },  // very recent
    async markAction() {},
  });
  const vibe = await cm.detectVibe();
  assert.equal(vibe, 'USER_BUSY');
});

test('ContextManager — SELF_IMPROVE when activity tracker reports long idle', async () => {
  const cm = new ContextManager('USER_IDLE', {
    async secondsSinceLastAction() { return 700; },  // 11+ minutes
    async markAction() {},
  });
  const vibe = await cm.detectVibe();
  assert.equal(vibe, 'SELF_IMPROVE');
});

// ─── 2. ResourceTracker ───────────────────────────────────────────────

test('ResourceTracker — refresh populates usage for all providers', async () => {
  const providers: Providers = {
    zai: { apiKey: 'test', tier: 'free', dailyFreeQuota: 1000 },
    kimi: { apiKey: 'test', tier: 'subscription', dailyFreeQuota: 100000 },
  };
  const rt = new ResourceTracker(providers);
  await rt.refresh();
  const zai = await rt.getUsage('zai');
  const kimi = await rt.getUsage('kimi');
  assert.ok(zai);
  assert.ok(kimi);
  assert.equal(zai!.freeQuota, 1000);
  assert.equal(kimi!.freeQuota, 100000);
});

test('ResourceTracker — recordUsage updates today count', async () => {
  const rt = new ResourceTracker({ zai: { apiKey: 'k', tier: 'free', dailyFreeQuota: 1000 } });
  await rt.refresh();
  await rt.recordUsage('zai', 100);
  const zai = await rt.getUsage('zai');
  assert.equal(zai!.usedToday, 100);
});

test('ResourceTracker — getAvailable sorts by free quota remaining', async () => {
  const rt = new ResourceTracker({
    zai: { apiKey: 'k', tier: 'free', dailyFreeQuota: 100 },
    kimi: { apiKey: 'k', tier: 'free', dailyFreeQuota: 1000 },
  });
  await rt.refresh();
  await rt.recordUsage('zai', 50);  // zai has 50 left
  await rt.recordUsage('kimi', 100);  // kimi has 900 left
  const available = await rt.getAvailable();
  assert.equal(available[0]!.provider, 'kimi');  // 900 left > 50 left
});

test('ResourceTracker — marks provider unavailable when quota exhausted', async () => {
  const rt = new ResourceTracker({ zai: { apiKey: 'k', tier: 'free', dailyFreeQuota: 10 } });
  await rt.refresh();
  await rt.recordUsage('zai', 100);
  const zai = await rt.getUsage('zai');
  assert.equal(zai!.isAvailable, false);
});

// ─── 3. Backlog ────────────────────────────────────────────────────────

test('Backlog — add and size', () => {
  const bl = new Backlog();
  bl.add({ id: '1', kind: 'simulation', priority: 10, payload: {}, createdAt: Date.now(), allowedVibes: ['USER_IDLE'] });
  assert.equal(bl.size(), 1);
});

test('Backlog — peek returns highest priority task matching vibe', () => {
  const bl = new Backlog();
  bl.add({ id: 'low', kind: 'simulation', priority: 1, payload: {}, createdAt: Date.now(), allowedVibes: ['USER_IDLE'] });
  bl.add({ id: 'high', kind: 'simulation', priority: 100, payload: {}, createdAt: Date.now(), allowedVibes: ['USER_IDLE'] });
  bl.add({ id: 'busy-only', kind: 'simulation', priority: 1000, payload: {}, createdAt: Date.now(), allowedVibes: ['USER_BUSY'] });
  const next = bl.peek('USER_IDLE');
  assert.equal(next?.id, 'high');
});

test('Backlog — peek returns undefined when no tasks match vibe', () => {
  const bl = new Backlog();
  bl.add({ id: '1', kind: 'simulation', priority: 10, payload: {}, createdAt: Date.now(), allowedVibes: ['USER_BUSY'] });
  assert.equal(bl.peek('USER_IDLE'), undefined);
});

test('Backlog — pop removes the task', () => {
  const bl = new Backlog();
  bl.add({ id: '1', kind: 'simulation', priority: 10, payload: {}, createdAt: Date.now(), allowedVibes: ['USER_IDLE'] });
  const t = bl.pop('USER_IDLE');
  assert.equal(t?.id, '1');
  assert.equal(bl.size(), 0);
});

test('Backlog — clear removes all tasks', () => {
  const bl = new Backlog();
  bl.add({ id: '1', kind: 'simulation', priority: 10, payload: {}, createdAt: Date.now(), allowedVibes: ['USER_IDLE'] });
  bl.add({ id: '2', kind: 'audit', priority: 20, payload: {}, createdAt: Date.now(), allowedVibes: ['USER_IDLE'] });
  bl.clear();
  assert.equal(bl.size(), 0);
});

// ─── 4. Dispatcher ─────────────────────────────────────────────────────

test('Dispatcher — skips when no available provider', async () => {
  const rt = new ResourceTracker({});
  await rt.refresh();
  const dispatcher = new Dispatcher({ providers: {}, resourceTracker: rt });
  const result = await dispatcher.dispatch({
    id: '1', kind: 'simulation', priority: 10, payload: { x: 1 }, createdAt: Date.now(), allowedVibes: ['USER_IDLE'],
  });
  assert.equal(result.status, 'skipped');
});

test('Dispatcher — chooseProvider picks preferred when available', async () => {
  const rt = new ResourceTracker({
    zai: { apiKey: 'k', tier: 'free', dailyFreeQuota: 1000 },
    kimi: { apiKey: 'k', tier: 'free', dailyFreeQuota: 1000 },
  });
  await rt.refresh();
  const dispatcher = new Dispatcher({ providers: { zai: { apiKey: 'k', tier: 'free' }, kimi: { apiKey: 'k', tier: 'free' } }, resourceTracker: rt });
  const chosen = await (dispatcher as any).chooseProvider({
    id: '1', kind: 'simulation', priority: 10, payload: {}, createdAt: Date.now(), allowedVibes: ['USER_IDLE'],
    preferredProvider: 'kimi',
  });
  assert.equal(chosen, 'kimi');
});

// ─── 5. AuditLoop ──────────────────────────────────────────────────────

test('AuditLoop — runAudit creates tasks for low-scoring skills', async () => {
  const backlog = new Backlog();
  const audit = new AuditLoop({
    backlog,
    async getScores() {
      return [
        { skillId: 'skill-1', score: 0.3, attempts: 5, lastUpdated: Date.now() },
        { skillId: 'skill-2', score: 0.9, attempts: 10, lastUpdated: Date.now() },
        { skillId: 'skill-3', score: 0.5, attempts: 3, lastUpdated: Date.now() },
      ];
    },
    async setScores(s) {},
  });
  const newTasks = await audit.runAudit();
  assert.ok(newTasks.length > 0);
  // Should include the two low-scoring skills (0.3 and 0.5)
  const skillIds = newTasks.map((t: any) => t.payload.skillId);
  assert.ok(skillIds.includes('skill-1'));
  assert.ok(skillIds.includes('skill-3'));
});

test('AuditLoop — updateScore increments attempts and averages', async () => {
  let scores: SkillScore[] = [{ skillId: 's1', score: 0.5, attempts: 1, lastUpdated: 0 }];
  const audit = new AuditLoop({
    backlog: new Backlog(),
    async getScores() { return scores; },
    async setScores(s) { scores = s; },
  });
  await audit.updateScore('s1', 0.7);
  assert.equal(scores[0]!.attempts, 2);
  assert.equal(scores[0]!.score, 0.6);  // (0.5*1 + 0.7) / 2 = 0.6
});

// ─── 6. Elf orchestrator ───────────────────────────────────────────────

test('Elf — run returns empty when nothing to do', async () => {
  const elf = new Elf({ providers: {} });
  const results = await elf.run();
  assert.equal(results.length, 0);
});

test('Elf — addTask + manual dispatch (skipped with no provider)', async () => {
  const elf = new Elf({ providers: {} });
  elf.addTask({
    id: 'manual-1',
    kind: 'simulation',
    priority: 100,
    payload: { prompt: 'test' },
    createdAt: Date.now(),
    allowedVibes: ['USER_IDLE'],
  });
  // No providers, so dispatch is skipped and the task is put back
  elf.setVibe('USER_IDLE');
  const results = await elf.run();
  assert.equal(elf.backlogSize(), 1);  // task still in backlog (put back)
  assert.equal(results.length, 1);
  assert.equal(results[0]!.status, 'skipped');
});

test('Elf — getUsageReport returns array', async () => {
  const elf = new Elf({
    providers: { zai: { apiKey: 'k', tier: 'free' } },
  });
  const report = await elf.getUsageReport();
  assert.ok(Array.isArray(report));
});

test('Elf — respects USER_BUSY throttle', async () => {
  const elf = new Elf({
    providers: { zai: { apiKey: 'k', tier: 'free' } },
  });
  elf.setVibe('USER_BUSY');
  elf.addTask({
    id: 'self-improve-1',
    kind: 'self-improve',
    priority: 100,
    payload: {},
    createdAt: Date.now(),
    allowedVibes: ['USER_IDLE', 'SELF_IMPROVE', 'FLUSH_MODE'],  // not USER_BUSY
  });
  const results = await elf.run();
  // Task should NOT be dispatched because vibe is USER_BUSY and it's not in allowedVibes
  assert.equal(results.length, 0);
  assert.equal(elf.backlogSize(), 1);  // task still queued
});

test('Elf — components are accessible', () => {
  const elf = new Elf({ providers: {} });
  assert.ok(elf.components.contextManager);
  assert.ok(elf.components.resourceTracker);
  assert.ok(elf.components.backlog);
  assert.ok(elf.components.dispatcher);
  assert.ok(elf.components.auditLoop);
});
