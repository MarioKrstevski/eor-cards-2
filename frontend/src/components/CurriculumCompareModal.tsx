import { useMemo, useState } from 'react';
import type { CurriculumNode, MergedNode } from '../types';
import { compareCurriculum, updateCurriculumNode, deleteCurriculumNode, apiErrorMessage } from '../api';

/**
 * Compare a pasted nested-topic JSON (the expected blueprint, e.g. extracted
 * from the new PAEA PDF) against the system's curriculum under a main topic.
 *
 * Status meanings IN THIS TOOL (the diff engine treats the JSON as "the
 * document"): 'missing' = in the system but NOT in the JSON → an INTRUDER
 * (extra topic). 'new' = in the JSON but absent from the system. Intruders can
 * be marked green (kept + flagged, cascades to subtree + sections) or removed
 * (subtree + sections deleted, so a re-upload re-creates them green).
 */
interface Props {
  roots: CurriculumNode[]; // level-0 main topics of the current version
  onClose: () => void;
  onChanged: () => void;   // refresh the library tree after mutations
}

export default function CurriculumCompareModal({ roots, onClose, onChanged }: Props) {
  const [mainId, setMainId] = useState<number | ''>('');
  const [jsonText, setJsonText] = useState('');
  const [tree, setTree] = useState<MergedNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [actingOn, setActingOn] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutated, setMutated] = useState(false);

  const counts = useMemo(() => {
    const c = { matched: 0, fuzzy: 0, missing: 0, new: 0 };
    const walk = (n: MergedNode) => {
      if (n.depth > 0) c[n.status] += 1;
      n.children.forEach(walk);
    };
    if (tree) walk(tree);
    return c;
  }, [tree]);

  async function runCompare() {
    if (mainId === '') { setError('Pick a main topic first'); return; }
    let nodes: unknown;
    try {
      nodes = JSON.parse(jsonText);
    } catch {
      setError('Invalid JSON — paste a nested [{"name", "children"}] list');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await compareCurriculum(mainId, nodes);
      setTree(res.tree);
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Compare failed'));
    } finally {
      setBusy(false);
    }
  }

  async function markGreen(node: MergedNode) {
    if (node.node_id == null) return;
    setActingOn(node.node_id);
    setError(null);
    try {
      await updateCurriculumNode(node.node_id, { color: 'green', cascade_green: true });
      setMutated(true);
      await runCompare(); // re-diff so the tree reflects the new colors
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Failed to mark green'));
    } finally {
      setActingOn(null);
    }
  }

  async function removeSubtree(node: MergedNode) {
    if (node.node_id == null) return;
    if (!window.confirm(
      `Remove "${node.name}" with all its subtopics AND any sections (incl. their cards) attached to them?\n\n` +
      'Re-uploading the document afterwards will re-create them through the reconcile flow — green from the start.'
    )) return;
    setActingOn(node.node_id);
    setError(null);
    try {
      await deleteCurriculumNode(node.node_id, true);
      setMutated(true);
      await runCompare();
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Failed to remove'));
    } finally {
      setActingOn(null);
    }
  }

  function close() {
    if (mutated) onChanged();
    onClose();
  }

  function NodeRow({ node }: { node: MergedNode }) {
    const isIntruder = node.status === 'missing';
    const isNew = node.status === 'new';
    const green = node.color === 'green';
    return (
      <div>
        <div
          className="flex items-center gap-1.5 py-0.5 pr-2 hover:bg-gray-50 rounded"
          style={{ paddingLeft: `${8 + node.depth * 14}px` }}
        >
          <span className={`flex-1 text-xs truncate ${
            green ? 'text-green-600 font-medium'
            : isIntruder ? 'text-amber-700 font-medium'
            : isNew ? 'text-blue-600'
            : node.status === 'fuzzy' ? 'text-gray-700'
            : 'text-gray-500'
          }`}>
            {node.name}
            {node.status === 'fuzzy' && node.doc_name && (
              <span className="ml-1 text-[10px] text-gray-400">≈ “{node.doc_name}”</span>
            )}
          </span>
          {green && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 font-semibold shrink-0">green</span>}
          {isIntruder && !green && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 font-semibold shrink-0">extra — not in blueprint</span>
          )}
          {isNew && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 font-semibold shrink-0">not in system</span>
          )}
          {isIntruder && (
            <span className="flex items-center gap-1 shrink-0">
              {!green && (
                <button
                  onClick={() => markGreen(node)}
                  disabled={actingOn !== null}
                  className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                  title="Keep this topic — mark it (and its subtree + sections) green"
                >
                  {actingOn === node.node_id ? '…' : 'Mark green'}
                </button>
              )}
              <button
                onClick={() => removeSubtree(node)}
                disabled={actingOn !== null}
                className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 disabled:opacity-50"
                title="Delete this topic subtree + its sections, so a re-upload re-creates them green"
              >
                Remove
              </button>
            </span>
          )}
        </div>
        {node.children.map((c, i) => <NodeRow key={c.node_id ?? `h${c.hid ?? i}`} node={c} />)}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={close}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-[860px] max-w-[95vw] max-h-[88vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
          <div>
            <h2 className="text-sm font-bold text-gray-900">Compare against blueprint JSON</h2>
            <p className="text-[11px] text-gray-500">
              Paste the expected topics (nested {'{name, children}'} JSON). Topics in the system that the
              JSON doesn’t have are flagged as <span className="text-amber-700 font-medium">extra</span> — mark them green or remove them.
            </p>
          </div>
          <button onClick={close} className="text-gray-400 hover:text-gray-600 p-1">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-4 py-3 border-b border-gray-100 shrink-0 space-y-2">
          <div className="flex items-center gap-2">
            <select
              value={mainId}
              onChange={(e) => setMainId(e.target.value ? Number(e.target.value) : '')}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— main topic —</option>
              {roots.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <button
              onClick={runCompare}
              disabled={busy || mainId === '' || !jsonText.trim()}
              className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? 'Comparing…' : 'Compare'}
            </button>
            {tree && (
              <span className="text-[11px] text-gray-500 ml-auto">
                {counts.matched} matched · {counts.fuzzy} fuzzy ·{' '}
                <span className="text-amber-700 font-medium">{counts.missing} extra</span> ·{' '}
                <span className="text-blue-600">{counts.new} not in system</span>
              </span>
            )}
          </div>
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder='[{"name": "Cardiovascular", "children": [{"name": "Arrhythmias"}]}, …]'
            rows={tree ? 3 : 8}
            className="w-full text-[11px] font-mono border border-gray-200 rounded-lg px-2 py-1.5 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
          />
          {error && <p className="text-[11px] text-red-600">{error}</p>}
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {tree
            ? <NodeRow node={tree} />
            : <p className="text-xs text-gray-400 text-center py-8">Pick a main topic, paste the blueprint JSON, hit Compare.</p>}
        </div>
      </div>
    </div>
  );
}
