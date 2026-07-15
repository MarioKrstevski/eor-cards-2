import { useEffect, useRef, useState } from 'react';
import {
  toEditorHtml,
  fromEditorHtml,
  unitsOut,
  rangeHasBold,
  rangeHasCloze,
  clozeAncestor,
  applyBoldToRange,
  toggleClozeOnRange,
} from './CardEditPopup';

interface ClozeMiniEditorProps {
  value: string;                        // stored front/extra HTML
  onChange: (frontHtml: string) => void; // called with serialized stored HTML after every change
  placeholder?: string;
}

// A compact rendered editor (blue clozes / bold) with three deterministic
// buttons — Bold/Unbold, Cloze/Uncloze, Units out — for use inside the split /
// combine / recreate review cards. Reuses the popup's TESTED DOM cores; it does
// NOT re-implement bold/cloze. No undo, no save button: the parent's Accept
// applies whatever onChange last reported.
export default function ClozeMiniEditor({ value, onChange, placeholder }: ClozeMiniEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [boldMode, setBoldMode] = useState<'bold' | 'unbold'>('bold');
  const [clozeMode, setClozeMode] = useState<'cloze' | 'uncloze'>('cloze');
  const [boldEnabled, setBoldEnabled] = useState(false);
  const [clozeEnabled, setClozeEnabled] = useState(false);

  // Seed the editor once on mount (and when the incoming value identity changes
  // from outside). We deliberately do NOT re-seed on every keystroke — the
  // contentEditable owns its DOM; the parent state is kept in sync via onChange.
  useEffect(() => {
    const el = editorRef.current;
    if (el) el.innerHTML = toEditorHtml(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The active range if — and only if — it lives inside THIS editor. Multiple
  // mini-editors mount at once, so every selection query is scoped to our root.
  function ownRange(): { root: HTMLElement; range: Range } | null {
    const root = editorRef.current;
    if (!root) return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    return { root, range };
  }

  // Recompute button labels/enabled state from the live selection — but only
  // when that selection is inside this editor (guards against sibling editors).
  function refreshSelectionState() {
    const er = ownRange();
    if (!er) return;
    const { root, range } = er;
    const collapsed = range.collapsed;

    const startCz = clozeAncestor(range.startContainer, root);
    const endCz = clozeAncestor(range.endContainer, root);
    const entirelyInCloze = !!startCz && startCz === endCz;

    const hasCloze = !!rangeHasCloze(range, root);
    setBoldMode(rangeHasBold(range, root) ? 'unbold' : 'bold');
    setBoldEnabled(!collapsed && !entirelyInCloze);
    setClozeMode(hasCloze ? 'uncloze' : 'cloze');
    // Uncloze works from a collapsed caret inside a cloze; cloze needs a range.
    setClozeEnabled(hasCloze || !collapsed);
  }

  // Scoped selectionchange listener: react only when the selection is in us.
  useEffect(() => {
    const handler = () => refreshSelectionState();
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Serialize the editor DOM back to stored HTML and report it upward.
  function emit() {
    const root = editorRef.current;
    if (root) onChange(fromEditorHtml(root));
  }

  function handleBold() {
    const er = ownRange();
    if (!er || er.range.collapsed) return;
    applyBoldToRange(er.root, er.range);
    refreshSelectionState();
    emit();
  }

  function handleCloze() {
    const er = ownRange();
    if (!er) return;
    toggleClozeOnRange(er.root, er.range);
    refreshSelectionState();
    emit();
  }

  function handleUnitsOut() {
    const root = editorRef.current;
    if (!root) return;
    root.innerHTML = toEditorHtml(unitsOut(fromEditorHtml(root)));
    refreshSelectionState();
    emit();
  }

  const isEmpty = !value || value.trim() === '';

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleBold}
          disabled={!boldEnabled}
          title={boldMode === 'unbold' ? 'Remove bold from the selection' : 'Bold the selection'}
          className="min-w-[64px] text-center px-2 py-1 text-[11px] font-semibold text-gray-700 bg-white border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
        >
          {boldMode === 'unbold' ? 'Unbold' : 'Bold'}
        </button>
        <button
          type="button"
          onClick={handleCloze}
          disabled={!clozeEnabled}
          title={clozeMode === 'uncloze' ? 'Remove the cloze from the selection' : 'Cloze the selection'}
          className="min-w-[64px] text-center px-2 py-1 text-[11px] font-medium text-gray-700 bg-white border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
        >
          {clozeMode === 'uncloze' ? 'Uncloze' : 'Cloze'}
        </button>
        <button
          type="button"
          onClick={handleUnitsOut}
          title="Move a trailing unit outside the cloze, e.g. {{c1::20 years}} → {{c1::20}} years."
          className="px-2 py-1 text-[11px] font-medium text-gray-700 bg-white border border-gray-200 rounded hover:bg-gray-50 transition-colors duration-150"
        >
          Units out
        </button>
      </div>
      <div className="relative">
        {isEmpty && placeholder && (
          <span className="pointer-events-none absolute left-2 top-1.5 text-xs text-gray-300 italic">{placeholder}</span>
        )}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onMouseUp={refreshSelectionState}
          onKeyUp={refreshSelectionState}
          onInput={emit}
          onBlur={emit}
          className="w-full min-h-[44px] text-sm leading-relaxed text-gray-800 border border-gray-200 rounded px-2 py-1.5 whitespace-pre-wrap focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>
    </div>
  );
}
