import type { CurriculumNode, TopicCoverageStats } from './types';

export type TopicSortMode = 'curriculum' | 'alpha';

/** Deep-sort a curriculum tree. Returns a new array (does not mutate). */
export function sortTree(nodes: CurriculumNode[], mode: TopicSortMode): CurriculumNode[] {
  const sorted = [...nodes].sort((a, b) =>
    mode === 'alpha'
      ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      : a.sort_order - b.sort_order
  );
  return sorted.map((n) => ({
    ...n,
    children: sortTree(n.children, mode),
  }));
}

export function flattenTree(nodes: CurriculumNode[]): CurriculumNode[] {
  const result: CurriculumNode[] = [];
  function walk(list: CurriculumNode[]) {
    for (const node of list) {
      result.push(node);
      if (node.children.length > 0) walk(node.children);
    }
  }
  walk(nodes);
  return result;
}

/** Returns the set of IDs for a node and all its descendants. */
export function subtreeIds(node: CurriculumNode): Set<number> {
  const ids = new Set<number>();
  function walk(n: CurriculumNode) {
    ids.add(n.id);
    for (const child of n.children) walk(child);
  }
  walk(node);
  return ids;
}

const emptyCoverage = (): TopicCoverageStats => ({ total: 0, active: 0, rejected: 0, unreviewed: 0 });

function addCoverage(a: TopicCoverageStats, b: TopicCoverageStats): TopicCoverageStats {
  return {
    total: a.total + b.total,
    active: a.active + b.active,
    rejected: a.rejected + b.rejected,
    unreviewed: a.unreviewed + b.unreviewed,
  };
}

/** Builds a Record<nodeId, aggregatedCoverageStats> for the full tree. */
export function buildAggregatedCounts(
  tree: CurriculumNode[],
  directCounts: Record<string, TopicCoverageStats>
): Record<string, TopicCoverageStats> {
  const result: Record<string, TopicCoverageStats> = {};
  function walkOnce(node: CurriculumNode): TopicCoverageStats {
    const direct = directCounts[String(node.id)] ?? emptyCoverage();
    const childSum = node.children.reduce<TopicCoverageStats>(
      (acc, c) => addCoverage(acc, walkOnce(c)),
      emptyCoverage()
    );
    result[String(node.id)] = addCoverage(direct, childSum);
    return result[String(node.id)];
  }
  tree.forEach((root) => walkOnce(root));
  return result;
}
