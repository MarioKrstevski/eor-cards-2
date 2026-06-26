import { useEffect, useMemo, useState } from 'react';
import type { ReconcileDiff, ReconcileSubtreeNode } from '../types';
import { createCurriculumNode, getReconcile, continueProcessing } from '../api';

interface ReconcileModalProps {
  uploadId: number;
  diff: ReconcileDiff;
  onClose: () => void;
  onContinue: (processingJobId: number) => void;
}

// Level badge palette (mirrors CurriculumPicker / LibraryPage)
const LEVEL_STYLES = [
  'bg-purple-50 text-purple-700',
  'bg-blue-50 text-blue-700',
  'bg-green-50 text-green-700',
  'bg-orange-50 text-orange-700',
];

interface TreeNode extends ReconcileSubtreeNode {
  children: TreeNode[];
}

// Build a nested tree from the flat subtree, rooted at main_topic.
function buildTree(subtree: ReconcileSubtreeNode[], rootId: number): TreeNode | null {
  const byId = new Map<number, TreeNode>();
  for (const n of subtree) byId.set(n.id, { ...n, children: [] });
  for (const n of subtree) {
    if (n.parent_id != null && byId.has(n.parent_id) && n.id !== rootId) {
      byId.get(n.parent_id)!.children.push(byId.get(n.id)!);
    }
  }
  return byId.get(rootId) ?? null;
}

function TreeNodeRow({ node, baseLevel }: { node: TreeNode; baseLevel: number }) {
  const depth = node.level - baseLevel;
  const levelStyle = LEVEL_STYLES[Math.min(node.level, LEVEL_STYLES.length - 1)];
  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1 text-gray-700"
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        <span className={`text-[9px] font-bold w-4 text-center rounded shrink-0 py-px ${levelStyle}`}>
          {node.level}
        </span>
        <span className="text-xs truncate">{node.name}</span>
      </div>
      {node.children.map((child) => (
        <TreeNodeRow key={child.id} node={child} baseLevel={baseLevel} />
      ))}
    </div>
  );
}

export default function ReconcileModal({ uploadId, diff: initialDiff, onClose, onContinue }: ReconcileModalProps) {
  const [diff, setDiff] = useState<ReconcileDiff>(initialDiff);
  const [addingHid, setAddingHid] = useState<number | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const tree = useMemo(
    () => buildTree(diff.subtree, diff.main_topic.id),
    [diff.subtree, diff.main_topic.id]
  );

  // Count missing / not-in-doc per depth for the level summary
  const missingByDepth = useMemo(() => {
    const m = new Map<number, number>();
    for (const item of diff.missing_in_curriculum) m.set(item.depth, (m.get(item.depth) ?? 0) + 1);
    return m;
  }, [diff.missing_in_curriculum]);

  const notInDocByDepth = useMemo(() => {
    const m = new Map<number, number>();
    for (const item of diff.not_in_document) m.set(item.depth, (m.get(item.depth) ?? 0) + 1);
    return m;
  }, [diff.not_in_document]);

  async function handleAddNode(hid: number, name: string, parentId: number | null) {
    setAddingHid(hid);
    setError(null);
    try {
      await createCurriculumNode({
        name,
        parent_id: parentId ?? diff.main_topic.id,
      });
      const fresh = await getReconcile(uploadId);
      setDiff(fresh);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add node');
    } finally {
      setAddingHid(null);
    }
  }

  async function handleContinue() {
    setContinuing(true);
    setError(null);
    try {
      const { processing_job_id } = await continueProcessing(uploadId);
      onContinue(processing_job_id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to continue');
      setContinuing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" aria-modal="true" role="dialog">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white rounded-2xl shadow-lg w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">Curriculum check</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Before processing, we compared this document's headings against the curriculum for{' '}
            <span className="font-medium text-gray-700">{diff.main_topic.name}</span>. Review below, add any
            missing curriculum nodes, then continue.
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-4 overflow-y-auto space-y-5">
          {/* Per-level summary */}
          <div>
            <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Levels</h3>
            <div className="space-y-1.5">
              {diff.levels.length === 0 ? (
                <p className="text-xs text-gray-400 italic">No headings found in document.</p>
              ) : (
                diff.levels.map((lvl) => {
                  const missing = missingByDepth.get(lvl.depth) ?? 0;
                  const notInDoc = notInDocByDepth.get(lvl.depth) ?? 0;
                  const ok = lvl.present === lvl.expected && missing === 0;
                  return (
                    <div
                      key={lvl.depth}
                      className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg ${
                        ok ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'
                      }`}
                    >
                      <span className="shrink-0">{ok ? '✓' : '⚠'}</span>
                      <span className="font-medium">Depth {lvl.depth}:</span>
                      <span>
                        {lvl.present} found / {lvl.expected} expected
                      </span>
                      {(missing > 0 || notInDoc > 0) && (
                        <span className="text-[11px] opacity-80">
                          {missing > 0 && `${missing} missing in curriculum`}
                          {missing > 0 && notInDoc > 0 && ' · '}
                          {notInDoc > 0 && `${notInDoc} not in document`}
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Curriculum subtree */}
          <div>
            <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Curriculum</h3>
            <div className="border border-gray-200 rounded-lg px-3 py-2 max-h-56 overflow-y-auto">
              {tree ? (
                <TreeNodeRow node={tree} baseLevel={diff.main_topic.level} />
              ) : (
                <p className="text-xs text-gray-400 italic">No curriculum nodes.</p>
              )}
            </div>
          </div>

          {/* Missing in curriculum */}
          {diff.missing_in_curriculum.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">
                Headings missing from curriculum
              </h3>
              <div className="space-y-1.5">
                {diff.missing_in_curriculum.map((item) => (
                  <div
                    key={item.hid}
                    className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg bg-gray-50"
                  >
                    <span className="text-[9px] font-bold w-4 text-center rounded shrink-0 py-px bg-gray-200 text-gray-600">
                      {item.depth + 1}
                    </span>
                    <span className="flex-1 truncate text-gray-700">{item.name}</span>
                    <button
                      onClick={() => handleAddNode(item.hid, item.name, item.parent_id)}
                      disabled={addingHid === item.hid}
                      className="px-2.5 py-1 text-xs font-medium text-blue-700 border border-blue-200 rounded-md hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                    >
                      {addingHid === item.hid ? 'Adding…' : 'Add node'}
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-gray-500 mt-2">
                {diff.missing_in_curriculum.length} heading(s) will roll up to their parent if not added.
              </p>
            </div>
          )}

          {/* Warnings */}
          {diff.warnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <h3 className="text-xs font-semibold text-amber-800 mb-1">Warnings</h3>
              <ul className="list-disc list-inside space-y-0.5">
                {diff.warnings.map((w, i) => (
                  <li key={i} className="text-[11px] text-amber-700">{w}</li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2.5 shrink-0">
          <button
            onClick={onClose}
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
  );
}
