import { describe, expect, it } from 'vitest';
import { evaluateKeywordCooldown } from '../services/keywordCooldown.js';

describe('evaluateKeywordCooldown', () => {
  const now = new Date('2026-05-05T12:00:00.000Z');

  it('does not skip when consecutive zero-save runs are below threshold', () => {
    const decision = evaluateKeywordCooldown(
      [
        { totalSaved: 0, startedAt: new Date('2026-05-05T08:00:00.000Z') },
        { totalSaved: 0, startedAt: new Date('2026-05-04T16:00:00.000Z') },
        { totalSaved: 1, startedAt: new Date('2026-05-04T00:00:00.000Z') },
      ],
      { zeroSaveThreshold: 4, cooldownHours: 24, lookbackDays: 14 },
      now
    );

    expect(decision.shouldSkip).toBe(false);
    expect(decision.consecutiveZeroSaveRuns).toBe(2);
  });

  it('skips when threshold is reached and cooldown has not expired', () => {
    const decision = evaluateKeywordCooldown(
      [
        { totalSaved: 0, startedAt: new Date('2026-05-05T08:00:00.000Z') },
        { totalSaved: 0, startedAt: new Date('2026-05-05T00:00:00.000Z') },
        { totalSaved: 0, startedAt: new Date('2026-05-04T16:00:00.000Z') },
        { totalSaved: 0, startedAt: new Date('2026-05-04T08:00:00.000Z') },
      ],
      { zeroSaveThreshold: 4, cooldownHours: 24, lookbackDays: 14 },
      now
    );

    expect(decision.shouldSkip).toBe(true);
    expect(decision.consecutiveZeroSaveRuns).toBe(4);
    expect(decision.cooldownRemainingMs).toBeGreaterThan(0);
  });

  it('anchors cooldown to the run start time so cron-aligned scans do not slip by another cycle', () => {
    const decision = evaluateKeywordCooldown(
      [
        {
          totalSaved: 0,
          startedAt: new Date('2026-05-05T08:13:00.000Z'),
          completedAt: new Date('2026-05-05T08:13:00.000Z'),
        },
        {
          totalSaved: 0,
          startedAt: new Date('2026-05-05T00:05:00.000Z'),
          completedAt: new Date('2026-05-05T00:05:00.000Z'),
        },
        {
          totalSaved: 0,
          startedAt: new Date('2026-05-04T16:07:00.000Z'),
          completedAt: new Date('2026-05-04T16:05:00.000Z'),
        },
        {
          totalSaved: 0,
          startedAt: new Date('2026-05-04T08:09:00.000Z'),
          completedAt: new Date('2026-05-04T08:05:00.000Z'),
        },
      ],
      { zeroSaveThreshold: 4, cooldownHours: 24, lookbackDays: 14, scheduleIntervalHours: 8 },
      new Date('2026-05-06T08:00:00.000Z')
    );

    expect(decision.shouldSkip).toBe(false);
    expect(decision.cooldownRemainingMs).toBe(0);
    expect(decision.lastAttemptAt?.toISOString()).toBe('2026-05-05T08:00:00.000Z');
  });

  it('allows retry after cooldown expires', () => {
    const decision = evaluateKeywordCooldown(
      [
        { totalSaved: 0, startedAt: new Date('2026-05-04T00:00:00.000Z') },
        { totalSaved: 0, startedAt: new Date('2026-05-03T16:00:00.000Z') },
        { totalSaved: 0, startedAt: new Date('2026-05-03T08:00:00.000Z') },
        { totalSaved: 0, startedAt: new Date('2026-05-03T00:00:00.000Z') },
      ],
      { zeroSaveThreshold: 4, cooldownHours: 24, lookbackDays: 14 },
      now
    );

    expect(decision.shouldSkip).toBe(false);
    expect(decision.consecutiveZeroSaveRuns).toBe(4);
    expect(decision.cooldownRemainingMs).toBe(0);
  });

  it('disables cooldown when threshold is set to zero', () => {
    const decision = evaluateKeywordCooldown(
      [
        { totalSaved: 0, startedAt: new Date('2026-05-05T08:00:00.000Z') },
        { totalSaved: 0, startedAt: new Date('2026-05-05T00:00:00.000Z') },
        { totalSaved: 0, startedAt: new Date('2026-05-04T16:00:00.000Z') },
        { totalSaved: 0, startedAt: new Date('2026-05-04T08:00:00.000Z') },
      ],
      { zeroSaveThreshold: 0, cooldownHours: 24, lookbackDays: 14 },
      now
    );

    expect(decision.shouldSkip).toBe(false);
  });
});
