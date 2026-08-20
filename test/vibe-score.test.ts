/**
 * Tests for the vibe score (Kimi-recommended formula).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextManager } from '../src/index.ts';

test('Vibe score — at flush window, no user, no backlog, tokens fresh', async () => {
  const cm = new ContextManager('FLUSH_MODE', {
    async secondsSinceLastAction() { return 10000; },  // long idle
    async markAction() {},
  });
  // Pretend we're at 23:00 UTC (1h into flush window)
  // Hard to mock Date.now, but the formula is testable
  const score = await cm.computeVibeScore({ backlogSize: 0, freeTokensRemaining: 100, maxFreeTokens: 100 });
  assert.ok(score >= 0 && score <= 1, `score ${score} not in [0,1]`);
});

test('Vibe score — at idle, user active, no backlog', async () => {
  const cm = new ContextManager('USER_BUSY', {
    async secondsSinceLastAction() { return 5; },
    async markAction() {},
  });
  const score = await cm.computeVibeScore({ backlogSize: 0, freeTokensRemaining: 100, maxFreeTokens: 100 });
  // User active → user_factor should be low
  assert.ok(score < 0.7, `score ${score} should be < 0.7 when user is active`);
});

test('Vibe score — backlog factor saturates at 50', async () => {
  const cm = new ContextManager('USER_IDLE', {
    async secondsSinceLastAction() { return 1000; },
    async markAction() {},
  });
  const score0 = await cm.computeVibeScore({ backlogSize: 0, freeTokensRemaining: 0, maxFreeTokens: 100 });
  const score50 = await cm.computeVibeScore({ backlogSize: 50, freeTokensRemaining: 0, maxFreeTokens: 100 });
  const score100 = await cm.computeVibeScore({ backlogSize: 100, freeTokensRemaining: 0, maxFreeTokens: 100 });
  // 50 → 1, 100 → 1 (capped)
  assert.ok(score50 > score0, `score50 (${score50}) should be > score0 (${score0})`);
  assert.equal(score50, score100, `score50 should equal score100 (both capped)`);
});

test('Vibe score — token factor scales linearly', async () => {
  const cm = new ContextManager('USER_IDLE', {
    async secondsSinceLastAction() { return 1000; },
    async markAction() {},
  });
  const score100 = await cm.computeVibeScore({ backlogSize: 0, freeTokensRemaining: 100, maxFreeTokens: 100 });
  const score50 = await cm.computeVibeScore({ backlogSize: 0, freeTokensRemaining: 50, maxFreeTokens: 100 });
  const score0 = await cm.computeVibeScore({ backlogSize: 0, freeTokensRemaining: 0, maxFreeTokens: 100 });
  // Token factor: 1.0, 0.5, 0.0
  assert.ok(score100 > score50, `score100 (${score100}) > score50 (${score50})`);
  assert.ok(score50 > score0, `score50 (${score50}) > score0 (${score0})`);
});

test('Vibe score — all factors in [0, 1]', async () => {
  const cm = new ContextManager('USER_IDLE');
  for (const backlog of [0, 10, 50, 100]) {
    for (const tokens of [0, 25, 50, 100]) {
      const score = await cm.computeVibeScore({ backlogSize: backlog, freeTokensRemaining: tokens, maxFreeTokens: 100 });
      assert.ok(score >= 0 && score <= 1, `score ${score} out of [0,1] for backlog=${backlog} tokens=${tokens}`);
    }
  }
});
