import { useEffect, useMemo, useState } from 'react';
import type { MergedNode, ScanResult } from '../types';
import { updateCurriculumNode, continueProcessing, deleteScan, apiErrorMessage } from '../api';

interface ReconcileModalProps {
  scanToken: string;
  tree: MergedNode;
  summary: ScanResult['summary'];
  onClose: () => void;
  onContinue: (processingJobId: number) => void;
}

// Level badge palette (mirrors CurriculumPicker)
const LEVEL_STYLES = [
  'bg-purple-50 text-purple-700',
  'bg-blue-50 text-blue-700',
  'bg-green-50 text-green-700',
  'bg-orange-50 text-orange-700',
];

// ── Tree helpers ──────────────────────────────────────────────────────────────

// Does this node, or any descendant, have a non-matched status?
function hasNonMatched(node: MergedNode): boolean {
  if (node.status !== 'matched') return true;
  return node.children.some(hasNonMatched);
}

// Collect every `new` hid in a subtree (including the node itself if `new`).
function collectNewHids(node: MergedNode, acc: number[] = []): number[] {
  if (node.status === 'new' && node.hid != null) acc.push(node.hid);
  for (const c of node.children) collectNewHids(c, acc);
  return acc;
}

// Does this `new` node have any `new` descendant?
function hasNewDescendant(node: MergedNode): boolean {
  return node.children.some((c) => (c.status === 'new' && c.hid != null) || hasNewDescendant(c));
}

// Walk-up: build a map hid → chain of `new` ancestor hids (for include-with-parents).
function buildNewParentChains(
  node: MergedNode,
  ancestorNewHids: number[],
  out: Map<number, number[]>
): void {
  if (node.status === 'new' && node.hid != null) {
    out.set(node.hid, [...ancestorNewHids]);
    const nextAncestors = [...ancestorNewHids, node.hid];
    for (const c of node.children) buildNewParentChains(c, nextAncestors, out);
  } else {
    // A non-new node resets the `new` ancestor chain for its subtree.
    for (const c of node.children) buildNewParentChains(c, [], out);
  }
}

// Rename a node by node_id in a fresh copy of the tree.
function renameNode(node: MergedNode, nodeId: number, newName: string): MergedNode {
  if (node.node_id === nodeId) {
    return { ...node, name: newName, children: node.children };
  }
  return { ...node, children: node.children.map((c) => renameNode(c, nodeId, newName)) };
}

export default function ReconcileModal({
  scanToken,
  tree: initialTree,
  summary,
  onClose,
  onContinue,
}: ReconcileModalProps) {
  const [tree, setTree] = useState<MergedNode>(initialTree);
  const [included, setIncluded] = useState<Set<number>>(new Set());
  const [view, setView] = useState<'all' | 'diff'>('all');
  const [editingNodeId, setEditingNodeId] = useState<number | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (continuing) return; // continue in flight — deleting the scan would break it
        // Same cleanup as Cancel: delete the server-side scan sidecar first.
        try {
          await deleteScan(scanToken);
        } catch { /* best effort */ }
        onClose();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, scanToken, continuing]);

  // Map of new-hid → its `new` ancestor hids (so a child can't be included without its new parent)
  const newParentChains = useMemo(() => {
    const out = new Map<number, number[]>();
    buildNewParentChains(tree, [], out);
    return out;
  }, [tree]);

  // All `new` hids in the tree.
  const allNewHids = useMemo(() => collectNewHids(tree), [tree]);

  // Counts per status per depth, computed by walking the tree.
  const countsByDepth = useMemo(() => {
    const m = new Map<number, { matched: number; fuzzy: number; new: number; missing: number }>();
    function walk(node: MergedNode) {
      const row = m.get(node.depth) ?? { matched: 0, fuzzy: 0, new: 0, missing: 0 };
      row[node.status] += 1;
      m.set(node.depth, row);
      node.children.forEach(walk);
    }
    walk(tree);
    return m;
  }, [tree]);

  const totalNotIncluded = allNewHids.length - included.size;

  // ── Include logic ──────────────────────────────────────────────────────────

  function includeOn(hid: number) {
    setIncluded((prev) => {
      const next = new Set(prev);
      next.add(hid);
      // Walk up: add any `new` ancestor hids.
      for (const ancestor of newParentChains.get(hid) ?? []) next.add(ancestor);
      return next;
    });
  }

  function includeOff(node: MergedNode) {
    const descendants = collectNewHids(node); // includes node itself
    setIncluded((prev) => {
      const next = new Set(prev);
      for (const hid of descendants) next.delete(hid);
      return next;
    });
  }

  function toggleInclude(node: MergedNode) {
    if (node.hid == null) return;
    if (included.has(node.hid)) includeOff(node);
    else includeOn(node.hid);
  }

  function includeAllUnder(node: MergedNode) {
    const hids = collectNewHids(node);
    setIncluded((prev) => {
      const next = new Set(prev);
      // Add this subtree's new hids plus the node's own new ancestors.
      if (node.hid != null) for (const a of newParentChains.get(node.hid) ?? []) next.add(a);
      for (const hid of hids) next.add(hid);
      return next;
    });
  }

  function includeAllNew() {
    setIncluded(new Set(allNewHids));
  }

  // ── Edit-leaf rename ────────────────────────────────────────────────────────

  async function handleRename(node: MergedNode) {
    if (node.node_id == null) return;
    const newName = window.prompt('Rename curriculum node:', node.name);
    if (newName == null) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === node.name) return;
    setEditingNodeId(node.node_id);
    setError(null);
    try {
      await updateCurriculumNode(node.node_id, { name: trimmed });
      setTree((prev) => renameNode(prev, node.node_id!, trimmed));
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Failed to rename node'));
    } finally {
      setEditingNodeId(null);
    }
  }

  async function handleCancel() {
    try {
      await deleteScan(scanToken);
    } catch { /* best effort */ }
    onClose();
  }

  async function handleContinue() {
    setContinuing(true);
    setError(null);
    try {
      const { processing_job_id } = await continueProcessing(scanToken, [...included]);
      onContinue(processing_job_id);
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Failed to continue'));
      setContinuing(false);
    }
  }

  // ── Recursive node row ──────────────────────────────────────────────────────

  function TreeNodeRow({ node }: { node: MergedNode }) {
    // In diff view, hide fully-matched subtrees.
    if (view === 'diff' && !hasNonMatched(node)) return null;

    const levelStyle = LEVEL_STYLES[Math.min(node.depth, LEVEL_STYLES.length - 1)];
    // Greyed if matched (in diff view it's context) or missing.
    const greyed = node.status === 'matched' || node.status === 'missing';

    return (
      <div>
        <div
          className={`flex items-center gap-1.5 py-1 ${greyed ? 'text-gray-400' : 'text-gray-700'}`}
          style={{ paddingLeft: `${8 + node.depth * 14}px` }}
        >
          <span className={`text-[9px] font-bold w-4 text-center rounded shrink-0 py-px ${levelStyle}`}>
            {node.depth}
          </span>

          {node.status === 'new' && (
            <input
              type="checkbox"
              checked={node.hid != null && included.has(node.hid)}
              onChange={() => toggleInclude(node)}
              className="shrink-0 h-3.5 w-3.5 accent-blue-600"
            />
          )}

          <span className="text-xs truncate">{node.name}</span>

          {node.status === 'fuzzy' && (
            <span className="text-[10px] text-amber-700 bg-amber-50 rounded px-1.5 py-px shrink-0 truncate">
              ⚠ “{node.doc_name}” → “{node.name}”{node.score != null ? ` (${node.score})` : ''}
            </span>
          )}
          {node.status === 'missing' && (
            <span className="text-[10px] font-medium text-gray-500 bg-gray-100 rounded px-1.5 py-px shrink-0">
              Missing
            </span>
          )}
          {node.status === 'new' && (
            <span className="text-[10px] font-medium text-green-700 bg-green-50 rounded px-1.5 py-px shrink-0">
              New
            </span>
          )}

          {/* Per-row actions */}
          {node.status === 'fuzzy' && node.node_id != null && (
            <button
              onClick={() => handleRename(node)}
              disabled={editingNodeId === node.node_id}
              className="ml-auto px-2 py-0.5 text-[11px] font-medium text-blue-700 border border-blue-200 rounded hover:bg-blue-50 disabled:opacity-50 shrink-0"
            >
              {editingNodeId === node.node_id ? 'Saving…' : 'Edit leaf'}
            </button>
          )}
          {node.status === 'new' && hasNewDescendant(node) && (
            <button
              onClick={() => includeAllUnder(node)}
              className="ml-auto px-2 py-0.5 text-[11px] font-medium text-green-700 border border-green-200 rounded hover:bg-green-50 shrink-0"
            >
              Include all under here
            </button>
          )}
        </div>
        {node.children.map((child, i) => (
          <TreeNodeRow key={child.node_id ?? child.hid ?? `n${i}`} node={child} />
        ))}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" aria-modal="true" role="dialog">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={handleCancel} />

      <div className="relative bg-white rounded-2xl shadow-lg w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">Review before importing</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Add any new headings to the curriculum, then Continue.
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-4 overflow-y-auto space-y-4">
          {/* Summary bar */}
          <div className="space-y-1.5">
            {summary.map((lvl) => {
              const c = countsByDepth.get(lvl.depth) ?? { matched: 0, fuzzy: 0, new: 0, missing: 0 };
              const clean = c.fuzzy === 0 && c.new === 0 && c.missing === 0;
              return (
                <div
                  key={lvl.depth}
                  className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg ${
                    clean ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'
                  }`}
                >
                  <span className="shrink-0">{clean ? '✓' : '⚠'}</span>
                  <span className="font-medium">Depth {lvl.depth}:</span>
                  <span>
                    {c.matched} matched · {c.fuzzy} fuzzy · {c.new} new · {c.missing} missing
                  </span>
                </div>
              );
            })}
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-xs">
              <button
                onClick={() => setView('all')}
                className={`px-3 py-1.5 font-medium ${view === 'all' ? 'bg-blue-700 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                All
              </button>
              <button
                onClick={() => setView('diff')}
                className={`px-3 py-1.5 font-medium border-l border-gray-200 ${view === 'diff' ? 'bg-blue-700 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                Differences
              </button>
            </div>
            {allNewHids.length > 0 && (
              <button
                onClick={includeAllNew}
                className="px-3 py-1.5 text-xs font-medium text-green-700 border border-green-200 rounded-lg hover:bg-green-50"
              >
                Include all new
              </button>
            )}
          </div>

          {/* Tree */}
          <div className="border border-gray-200 rounded-lg px-3 py-2 max-h-72 overflow-y-auto">
            <TreeNodeRow node={tree} />
          </div>

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex items-center gap-2.5 shrink-0">
          {totalNotIncluded > 0 && (
            <p className="text-[11px] text-gray-500 flex-1">
              {totalNotIncluded} new heading(s) not included will roll up to their parent.
            </p>
          )}
          <div className="flex justify-end gap-2.5 ml-auto">
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={handleContinue}
              disabled={continuing}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {continuing ? 'Starting…' : 'Continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
