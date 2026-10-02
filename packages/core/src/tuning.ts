export const tuning = {
  bm25: { k1: 1.2, b: 0.75 },
  weights: {
    title: 4,
    symbols: 4,
    tags: 3,
    intent: 2,
    deps: 1.5,
    identifiers: 1,
    whenNot: 0.5,
  },
  search: {
    agentLimit: 3,
    quickPickLimit: 8,
    weakScore: 0.3,
    duplicateScore: 0.8,
    useBoostCap: 10,
    useBoost: 0.05,
    recentDays: 30,
    recentBoost: 1.1,
    staleFactor: 0.6,
  },
  closure: {
    maxDepth: 2,
    maxWholeFileLines: 200,
  },
  limits: {
    slug: 48,
    tags: 8,
    text: 280,
  },
  lockStaleMs: 10_000,
} as const;
