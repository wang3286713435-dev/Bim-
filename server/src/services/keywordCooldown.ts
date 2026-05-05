type KeywordRunSnapshot = {
  totalSaved: number;
  startedAt: Date;
  completedAt?: Date | null;
};

export type KeywordCooldownPolicy = {
  zeroSaveThreshold: number;
  cooldownHours: number;
  lookbackDays: number;
  scheduleIntervalHours?: number;
};

export type KeywordCooldownDecision = {
  shouldSkip: boolean;
  consecutiveZeroSaveRuns: number;
  cooldownRemainingMs: number;
  nextEligibleAt?: Date;
  lastAttemptAt?: Date;
  lastSavedAt?: Date;
  recentRunCount: number;
};

function getSortTimestamp(run: KeywordRunSnapshot): Date {
  return run.completedAt ?? run.startedAt;
}

function floorToScheduleWindow(date: Date, intervalHours: number): Date {
  if (intervalHours <= 1) return date;
  const anchor = new Date(date);
  anchor.setMinutes(0, 0, 0);
  const flooredHour = Math.floor(anchor.getHours() / intervalHours) * intervalHours;
  anchor.setHours(flooredHour, 0, 0, 0);
  return anchor;
}

function getCooldownAnchor(run: KeywordRunSnapshot, policy: KeywordCooldownPolicy): Date {
  const intervalHours = policy.scheduleIntervalHours ?? 0;
  return intervalHours > 1
    ? floorToScheduleWindow(run.startedAt, intervalHours)
    : run.startedAt;
}

export function evaluateKeywordCooldown(
  runs: KeywordRunSnapshot[],
  policy: KeywordCooldownPolicy,
  now = new Date()
): KeywordCooldownDecision {
  const sortedRuns = [...runs]
    .sort((a, b) => getSortTimestamp(b).getTime() - getSortTimestamp(a).getTime());

  const latestRun = sortedRuns[0];
  const lastAttemptAt = latestRun ? getCooldownAnchor(latestRun, policy) : undefined;
  const lastSavedRun = sortedRuns.find((run) => (run.totalSaved ?? 0) > 0);
  const lastSavedAt = lastSavedRun ? getCooldownAnchor(lastSavedRun, policy) : undefined;

  let consecutiveZeroSaveRuns = 0;
  for (const run of sortedRuns) {
    if ((run.totalSaved ?? 0) > 0) break;
    consecutiveZeroSaveRuns += 1;
  }

  const thresholdEnabled = policy.zeroSaveThreshold > 0 && policy.cooldownHours > 0;
  const cooldownMs = policy.cooldownHours * 60 * 60 * 1000;
  const thresholdReached = thresholdEnabled && consecutiveZeroSaveRuns >= policy.zeroSaveThreshold;
  const nextEligibleAt = thresholdReached && lastAttemptAt
    ? new Date(lastAttemptAt.getTime() + cooldownMs)
    : undefined;
  const cooldownRemainingMs = nextEligibleAt
    ? Math.max(0, nextEligibleAt.getTime() - now.getTime())
    : 0;

  return {
    shouldSkip: Boolean(thresholdReached && cooldownRemainingMs > 0),
    consecutiveZeroSaveRuns,
    cooldownRemainingMs,
    nextEligibleAt,
    lastAttemptAt,
    lastSavedAt,
    recentRunCount: sortedRuns.length,
  };
}
