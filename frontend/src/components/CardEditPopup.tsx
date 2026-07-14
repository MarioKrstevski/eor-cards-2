import { useEffect, useRef, useState } from 'react';
import type { Card } from '../types';
import { useSettings } from '../context/SettingsContext';
import { rewordSnippet } from '../api';

type CardVersion = 'base' | 'v1' | 'v2' | 'v3';

// Read the front HTML for the active version. Each version is independent — no
// base fallback (matches getFieldValue in CardsPanel).
function frontFor(card: Card, ver: CardVersion): string {
  if (ver === 'v1') return card.front_html_v1 ?? '';
  if (ver === 'v2') return card.front_html_v2 ?? '';
  if (ver === 'v3') return card.front_html_v3 ?? '';
  return card.front_html ?? '';
}

// Move a trailing unit OUTSIDE the cloze: `{{c1::20 years}}` → `{{c1::20}} years`.
// Only fires when the value ends in a digit and is followed by a known unit.
const UNIT = '(?:weeks?|days?|hours?|months?|years?|minutes?|mins?|mg|mcg|kg|mL|L|mmHg|bpm|%|cm|mm|units?)';
const UNITS_OUT_RE = new RegExp(
  `\\{\\{c(\\d+)::([^}]*?\\d)\\s+(${UNIT})\\}\\}`,
  'gi'
);
export function unitsOut(text: string): string {
  return text.replace(UNITS_OUT_RE, (_m, c: string, value: string, unit: string) => `{{c${c}::${value}}} ${unit}`);
}

// ── Editor <-> stored-HTML conversion ─────────────────────────────────────────
// The contentEditable editor renders bold as <b> and clozes as blue-bold
// <span class="cz"> so the reviewer never sees raw markup. These two pure
// functions bridge that editor DOM with the stored front_html string.
//
//  stored cloze     : <span style="color:#1f77b4"><b>{{c1::TERM}}</b></span>
//  editor cloze     : <span class="cz" data-hint="HINT" style="color:#1f77b4;font-weight:700">TERM</span>
//  stored/editor bold: <b>TERM</b>

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// stored front_html → editor innerHTML.
// Cloze forms handled (tolerant): the full styled-span-with-<b> wrapper AND a
// bare `{{c1::..}}`. Non-cloze <b> is kept as bold; everything else passes
// through. We work purely on the string here (the input is our own clean stored
// HTML, not messy contentEditable output).
export function toEditorHtml(frontHtml: string): string {
  let out = frontHtml;

  // 1) Wrapped cloze: <span ...><b>{{c1::..}}</b></span> (optional <b>).
  out = out.replace(
    /<span[^>]*>(?:<b>)?\{\{c\d+::([\s\S]*?)\}\}(?:<\/b>)?<\/span>/g,
    (_m, body: string) => clozeSpan(body)
  );

  // 2) Any remaining bare cloze markers.
  out = out.replace(/\{\{c\d+::([\s\S]*?)\}\}/g, (_m, body: string) => clozeSpan(body));

  return out;
}

// Build an editor cloze span from a cloze body ("TERM" or "TERM::HINT").
function clozeSpan(body: string): string {
  const sep = body.indexOf('::');
  const term = sep === -1 ? body : body.slice(0, sep);
  const hint = sep === -1 ? '' : body.slice(sep + 2);
  return `<span class="cz" data-hint="${escapeAttr(hint)}" style="color:#1f77b4;font-weight:700">${escapeHtml(term)}</span>`;
}

// editor DOM → stored front_html. Walks childNodes (never regex the messy
// contentEditable output). Round-trips with toEditorHtml: cloze index is
// normalized to c1.
export function fromEditorHtml(node: HTMLElement): string {
  let out = '';
  node.childNodes.forEach((child) => {
    out += serializeNode(child);
  });
  return out;
}

function serializeNode(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  // Cloze span → stored cloze markup (re-append ::hint if present).
  if (el.classList.contains('cz')) {
    const term = el.textContent ?? '';
    const hint = el.getAttribute('data-hint') ?? '';
    const body = hint ? `${term}::${hint}` : term;
    return `<span style="color:#1f77b4"><b>{{c1::${body}}}</b></span>`;
  }

  // Recurse for children of container/inline elements.
  let inner = '';
  el.childNodes.forEach((c) => { inner += serializeNode(c); });

  // Non-cloze bold.
  if (tag === 'b' || tag === 'strong') {
    return `<b>${inner}</b>`;
  }
  // Line break / block cruft from the browser.
  if (tag === 'br') return '\n';
  if (tag === 'div' || tag === 'p') return inner + '\n';

  // Any other tag: drop the tag, keep its text.
  return inner;
}

interface CardEditPopupProps {
  card: Card;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSave: (id: number, patch: any) => void | Promise<void>;
  onRegenerate: (card: Card) => void;
  onClose: () => void;
}

// The correct patch key for the active version's front column.
function frontPatchKey(ver: CardVersion): string {
  return ver === 'v1' ? 'front_html_v1' : ver === 'v2' ? 'front_html_v2' : ver === 'v3' ? 'front_html_v3' : 'front_html';
}

// ── Selection / DOM helpers ───────────────────────────────────────────────────

// The nearest ancestor <b> (that is NOT a cloze span) of a node, bounded by the
// editor root. Returns null if none.
function boldAncestor(node: Node | null, root: HTMLElement): HTMLElement | null {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as HTMLElement;
      if (el.classList.contains('cz')) return null; // inside a cloze — not plain bold
      const tag = el.tagName.toLowerCase();
      if (tag === 'b' || tag === 'strong') return el;
    }
    n = n.parentNode;
  }
  return null;
}

// The nearest ancestor cloze span of a node, bounded by the editor root.
function clozeAncestor(node: Node | null, root: HTMLElement): HTMLElement | null {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).classList.contains('cz')) {
      return n as HTMLElement;
    }
    n = n.parentNode;
  }
  return null;
}

// Does [range] touch any bold (non-cloze) content? Used for BOLD/UNBOLD mode.
function rangeHasBold(range: Range, root: HTMLElement): boolean {
  // Endpoints inside a bold.
  if (boldAncestor(range.startContainer, root)) return true;
  if (boldAncestor(range.endContainer, root)) return true;
  // Any <b> fully or partially covered by the range.
  const bolds = root.querySelectorAll('b, strong');
  for (const b of Array.from(bolds)) {
    if ((b as HTMLElement).closest('.cz')) continue;
    if (range.intersectsNode(b)) return true;
  }
  return false;
}

// Does [range] touch any cloze span? Used for CLOZE/UNCLOZE mode.
function rangeHasCloze(range: Range, root: HTMLElement): HTMLElement | null {
  const inStart = clozeAncestor(range.startContainer, root);
  if (inStart) return inStart;
  const inEnd = clozeAncestor(range.endContainer, root);
  if (inEnd) return inEnd;
  const czs = root.querySelectorAll('.cz');
  for (const c of Array.from(czs)) {
    if (range.intersectsNode(c)) return c as HTMLElement;
  }
  return null;
}

type BoldMode = 'bold' | 'unbold';
type ClozeMode = 'cloze' | 'uncloze';

export default function CardEditPopup({ card, onSave, onRegenerate, onClose }: CardEditPopupProps) {
  const { activeCardVersion } = useSettings();
  const ver = activeCardVersion as CardVersion;
  const [hasSelection, setHasSelection] = useState(false);
  const [rewording, setRewording] = useState(false);
  const [saved, setSaved] = useState(false);
  const [boldMode, setBoldMode] = useState<BoldMode>('bold');
  const [clozeMode, setClozeMode] = useState<ClozeMode>('cloze');
  const [boldEnabled, setBoldEnabled] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  // Load the draft into the editor when the target card or active version
  // changes (never on background refresh mid-edit — id/version are stable).
  useEffect(() => {
    const el = editorRef.current;
    if (el) el.innerHTML = toEditorHtml(frontFor(card, ver));
    setHasSelection(false);
    setBoldMode('bold');
    setClozeMode('cloze');
    setBoldEnabled(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, ver]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Recompute button labels/state from the live selection, but only when the
  // selection is inside our editor.
  function refreshSelectionState() {
    const root = editorRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) { setHasSelection(false); return; }
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return; // selection elsewhere

    const collapsed = range.collapsed;
    setHasSelection(!collapsed);

    // Bold: enabled unless the selection is entirely inside a single cloze.
    const startCz = clozeAncestor(range.startContainer, root);
    const endCz = clozeAncestor(range.endContainer, root);
    const entirelyInCloze = !!startCz && startCz === endCz;
    setBoldEnabled(!collapsed && !entirelyInCloze);
    setBoldMode(rangeHasBold(range, root) ? 'unbold' : 'bold');

    // Cloze toggle mode.
    setClozeMode(rangeHasCloze(range, root) ? 'uncloze' : 'cloze');
  }

  useEffect(() => {
    document.addEventListener('selectionchange', refreshSelectionState);
    return () => document.removeEventListener('selectionchange', refreshSelectionState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The editor's plain text (cloze terms + bold text + plain text).
  function editorText(): string {
    return editorRef.current?.textContent ?? '';
  }

  // Get the active range if it lives inside the editor.
  function editorRange(): Range | null {
    const root = editorRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    return range;
  }

  // ── Bold / Unbold ───────────────────────────────────────────────────────────
  function handleBold() {
    const root = editorRef.current;
    const range = editorRange();
    if (!root || !range || range.collapsed) return;
    if (rangeHasBold(range, root)) unboldRange(range, root);
    else boldRange(range, root);
    refreshSelectionState();
  }

  // Wrap the exact selected range in a fresh <b> (skips content already inside a
  // cloze — those are styled separately).
  function boldRange(range: Range, root: HTMLElement) {
    const contents = range.extractContents();
    const b = document.createElement('b');
    b.appendChild(contents);
    range.insertNode(b);
    // Restore a selection around the new bold text.
    selectNodeContents(b, root);
    normalize(root);
  }

  // Remove bold across the whole selected range. Split any <b> at the range
  // boundaries and unwrap the covered portion.
  function unboldRange(range: Range, root: HTMLElement) {
    // Collect the <b> elements the range touches (endpoints + intersected).
    const affected = new Set<HTMLElement>();
    const startB = boldAncestor(range.startContainer, root);
    const endB = boldAncestor(range.endContainer, root);
    if (startB) affected.add(startB);
    if (endB) affected.add(endB);
    root.querySelectorAll('b, strong').forEach((b) => {
      const el = b as HTMLElement;
      if (el.closest('.cz')) return;
      if (range.intersectsNode(el)) affected.add(el);
    });

    // Split each affected <b> so only the covered part is unwrapped.
    affected.forEach((b) => splitAndUnwrapBold(b, range, root));
    normalize(root);
    // Re-select roughly the same text region if possible.
    const sel = window.getSelection();
    if (sel) { try { sel.removeAllRanges(); sel.addRange(range); } catch { /* range may be stale */ } }
  }

  // Given a <b> and the selection range, keep the portions OUTSIDE the range
  // bold and unwrap the portion INSIDE it. Works on the text of the <b>.
  function splitAndUnwrapBold(b: HTMLElement, range: Range, root: HTMLElement) {
    const bRange = document.createRange();
    bRange.selectNodeContents(b);

    // Intersection of the selection with this <b>.
    const startsBefore = range.compareBoundaryPoints(Range.START_TO_START, bRange) <= 0;
    const endsAfter = range.compareBoundaryPoints(Range.END_TO_END, bRange) >= 0;

    // Portion of b before the selection stays bold.
    let beforeFrag: DocumentFragment | null = null;
    if (!startsBefore) {
      const r = document.createRange();
      r.setStart(bRange.startContainer, bRange.startOffset);
      r.setEnd(range.startContainer, range.startOffset);
      beforeFrag = r.cloneContents();
    }
    // Portion after the selection stays bold.
    let afterFrag: DocumentFragment | null = null;
    if (!endsAfter) {
      const r = document.createRange();
      r.setStart(range.endContainer, range.endOffset);
      r.setEnd(bRange.endContainer, bRange.endOffset);
      afterFrag = r.cloneContents();
    }
    // Covered portion becomes plain (unwrapped).
    const coveredRange = document.createRange();
    coveredRange.setStart(
      startsBefore ? bRange.startContainer : range.startContainer,
      startsBefore ? bRange.startOffset : range.startOffset,
    );
    coveredRange.setEnd(
      endsAfter ? bRange.endContainer : range.endContainer,
      endsAfter ? bRange.endOffset : range.endOffset,
    );
    const coveredFrag = coveredRange.cloneContents();

    // Rebuild: [<b>before</b>] plainCovered [<b>after</b>] in place of b.
    const parent = b.parentNode;
    if (!parent) return;
    const frag = document.createDocumentFragment();
    if (beforeFrag && beforeFrag.textContent) {
      const nb = document.createElement('b');
      nb.appendChild(beforeFrag);
      frag.appendChild(nb);
    }
    frag.appendChild(coveredFrag);
    if (afterFrag && afterFrag.textContent) {
      const nb = document.createElement('b');
      nb.appendChild(afterFrag);
      frag.appendChild(nb);
    }
    parent.replaceChild(frag, b);
    void root;
  }

  // ── Cloze / Uncloze ───────────────────────────────────────────────────────────
  function handleCloze() {
    const root = editorRef.current;
    const range = editorRange();
    if (!root || !range) return;

    const existing = rangeHasCloze(range, root);
    if (existing) {
      // UNCLOZE: replace the span with its plain text.
      const text = document.createTextNode(existing.textContent ?? '');
      existing.parentNode?.replaceChild(text, existing);
      normalize(root);
      selectNode(text, root);
    } else {
      // CLOZE: guard against empty + nested.
      if (range.collapsed) return;
      if (clozeAncestor(range.startContainer, root) || clozeAncestor(range.endContainer, root)) return;
      const contents = range.extractContents();
      if (!contents.textContent) return;
      const span = document.createElement('span');
      span.className = 'cz';
      span.setAttribute('data-hint', '');
      span.setAttribute('style', 'color:#1f77b4;font-weight:700');
      span.appendChild(contents);
      range.insertNode(span);
      normalize(root);
      selectNodeContents(span, root);
    }
    refreshSelectionState();
  }

  // ── Reword ────────────────────────────────────────────────────────────────────
  async function handleReword() {
    const range = editorRange();
    if (!range || range.collapsed) return;
    const snippet = range.toString();
    if (!snippet.trim()) return;
    setRewording(true);
    try {
      const { reworded } = await rewordSnippet(editorText(), snippet);
      range.deleteContents();
      range.insertNode(document.createTextNode(reworded));
      normalize(editorRef.current!);
    } catch {
      /* leave the text untouched on failure */
    } finally {
      setRewording(false);
      refreshSelectionState();
    }
  }

  // ── Units out ─────────────────────────────────────────────────────────────────
  // Operate on the canonical stored string, then re-render into the editor.
  function handleUnitsOut() {
    const root = editorRef.current;
    if (!root) return;
    const stored = fromEditorHtml(root);
    root.innerHTML = toEditorHtml(unitsOut(stored));
    refreshSelectionState();
  }

  // ── Save ──────────────────────────────────────────────────────────────────────
  async function handleSave() {
    const root = editorRef.current;
    if (!root) return;
    await onSave(card.id, { [frontPatchKey(ver)]: fromEditorHtml(root) });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  // ── Small DOM utilities ─────────────────────────────────────────────────────
  function normalize(root: HTMLElement) {
    root.normalize();
  }
  function selectNodeContents(node: Node, root: HTMLElement) {
    const sel = window.getSelection();
    if (!sel || !root.contains(node)) return;
    const r = document.createRange();
    r.selectNodeContents(node);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function selectNode(node: Node, root: HTMLElement) {
    const sel = window.getSelection();
    if (!sel || !root.contains(node)) return;
    const r = document.createRange();
    r.selectNode(node);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  return (
    <div className="fixed right-4 top-24 w-80 z-40 bg-white rounded-xl border border-gray-200 shadow-2xl flex flex-col max-h-[calc(100vh-8rem)]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200">
        <span className="text-xs font-semibold text-gray-900">
          Edit card #{card.card_number}
          {ver !== 'base' && (
            <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-violet-50 text-violet-600 font-semibold uppercase">{ver}</span>
          )}
        </span>
        <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-50" title="Close (Esc)">✕</button>
      </div>

      <div className="p-3 flex flex-col gap-2.5 overflow-auto">
        {/* WYSIWYG editor: bold shows bold, clozes show as blue-bold terms. */}
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Front</p>
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onMouseUp={refreshSelectionState}
            onKeyUp={refreshSelectionState}
            className="w-full min-h-[120px] text-sm leading-relaxed text-gray-800 border border-gray-200 rounded-lg px-2.5 py-2 whitespace-pre-wrap focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={handleBold}
            disabled={!boldEnabled}
            title={boldMode === 'unbold' ? 'Remove bold from the selection' : 'Bold the selection'}
            className="px-2.5 py-1.5 text-xs font-semibold text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
          >
            {boldMode === 'unbold' ? 'Unbold' : 'Bold'}
          </button>
          <button
            onClick={handleCloze}
            disabled={clozeMode === 'cloze' && !hasSelection}
            title={clozeMode === 'uncloze' ? 'Remove the cloze from the selection' : 'Cloze the selection'}
            className="px-2.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
          >
            {clozeMode === 'uncloze' ? 'Uncloze' : 'Cloze'}
          </button>
          <button
            onClick={handleReword}
            disabled={!hasSelection || rewording}
            title={hasSelection ? 'Rephrase the selected text' : 'Select text to reword'}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
          >
            {rewording && <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            Reword
          </button>
          <button
            onClick={handleUnitsOut}
            title="Move a trailing unit outside the cloze, e.g. {{c1::20 years}} → {{c1::20}} years."
            className="px-2.5 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
          >
            Units out
          </button>
          <button
            onClick={() => onRegenerate(card)}
            title="Regenerate this card with a prompt"
            className="px-2.5 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors duration-150"
          >
            Regenerate
          </button>
          <button
            onClick={handleSave}
            className="ml-auto px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors duration-150"
          >
            {saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
