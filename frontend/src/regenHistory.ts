// Per-card regeneration history, kept in the browser (localStorage) only — never
// the DB. Before a card is regenerated we snapshot its current Card Text + Extra
// so the reviewer can roll back. Rolling back to a snapshot applies it and prunes
// that snapshot and everything newer (you've reverted past them).

export interface RegenSnapshot {
  ts: number;              // when the snapshot was taken (ms epoch)
  front_html: string;      // Card Text at snapshot time
  extra: string | null;    // Extra / additional context at snapshot time
}

export type RegenHistory = Record<number, RegenSnapshot[]>;

const KEY = 'regen_history_v1';

export function loadRegenHistory(): RegenHistory {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RegenHistory) : {};
  } catch {
    return {};
  }
}

function persist(h: RegenHistory): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(h));
  } catch {
    /* quota exceeded or storage disabled — history is best-effort */
  }
}

/** Append a pre-regeneration snapshot for each card. Returns the new history. */
export function pushSnapshots(
  history: RegenHistory,
  cards: Array<{ id: number; front_html: string; extra: string | null }>,
  ts: number,
): RegenHistory {
  const next: RegenHistory = { ...history };
  for (const c of cards) {
    const stack = next[c.id] ? [...next[c.id]] : [];
    stack.push({ ts, front_html: c.front_html ?? '', extra: c.extra ?? null });
    next[c.id] = stack;
  }
  persist(next);
  return next;
}

/**
 * Roll back: returns the snapshot at `index` plus a pruned history that keeps
 * only the snapshots older than it (index .. end are discarded). The caller is
 * responsible for applying the returned snapshot to the card.
 */
export function rollbackToIndex(
  history: RegenHistory,
  cardId: number,
  index: number,
): { snapshot: RegenSnapshot | null; history: RegenHistory } {
  const stack = history[cardId];
  if (!stack || index < 0 || index >= stack.length) return { snapshot: null, history };
  const snapshot = stack[index];
  const next: RegenHistory = { ...history };
  const remaining = stack.slice(0, index);
  if (remaining.length) next[cardId] = remaining;
  else delete next[cardId];
  persist(next);
  return { snapshot, history: next };
}
