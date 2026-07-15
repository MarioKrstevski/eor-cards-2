import { useEffect, useRef, useState } from 'react';
import type { Card } from '../types';
import { useSettings } from '../context/SettingsContext';
import { rewordSnippet, regenerateCardPreview } from '../api';

type CardVersion = 'base' | 'v1' | 'v2' | 'v3';

// Read the front HTML for the active version. Each version is independent — no
// base fallback (matches getFieldValue in CardsPanel).
function frontFor(card: Card, ver: CardVersion): string {
  if (ver === 'v1') return card.front_html_v1 ?? '';
  if (ver === 'v2') return card.front_html_v2 ?? '';
  if (ver === 'v3') return card.front_html_v3 ?? '';
  return card.front_html ?? '';
}

// Read the extra (footer) for the active version — same independence rule.
function extraFor(card: Card, ver: CardVersion): string {
  if (ver === 'v1') return card.extra_v1 ?? '';
  if (ver === 'v2') return card.extra_v2 ?? '';
  if (ver === 'v3') return card.extra_v3 ?? '';
  return card.extra ?? '';
}

// Move a trailing unit OUTSIDE the cloze: `{{c1::20 years}}` → `{{c1::20}} years`.
// Move a unit that sits INSIDE a cloze to just outside it — no unit list needed.
// Rule: keep the leading numeric value clozed, push everything from the first
// letter onward OUT of the cloze span entirely (not just out of the {{ }}).
//   {{c1::20 weeks}}    -> {{c1::20}} weeks
//   {{c1::120/80 mmHg}} -> {{c1::120/80}} mmHg
//   {{c1::20years}}     -> {{c1::20}}years
// No-ops when the cloze has no leading number (e.g. "first trimester", "Rh status").
const CLOZE_SPAN_RE =
  /<span style="color:#1f77b4"><b>\{\{c\d+::([\s\S]*?)\}\}<\/b><\/span>|\{\{c\d+::([\s\S]*?)\}\}/g;

function splitLeadingValue(body: string): { value: string; rest: string } | null {
  const letter = body.match(/[A-Za-z]/);
  if (!letter || letter.index === undefined) return null; // nothing to push out
  const prefix = body.slice(0, letter.index);
  if (!/\d/.test(prefix)) return null;                    // no number → not a value+unit cloze
  const value = prefix.replace(/\s+$/, '');               // keep the number, drop its trailing space
  return { value, rest: body.slice(value.length) };       // rest keeps the space + unit
}

// Operates on the serialized front_html, moving the unit fully outside the
// styled cloze span so it renders as plain text (fixes the markup-mangling bug).
export function unitsOut(frontHtml: string): string {
  return frontHtml.replace(CLOZE_SPAN_RE, (whole, styledBody?: string, bareBody?: string) => {
    const styled = styledBody !== undefined;
    const body = styled ? styledBody : (bareBody as string);
    const split = splitLeadingValue(body);
    if (!split) return whole;
    const cloze = styled
      ? `<span style="color:#1f77b4"><b>{{c1::${split.value}}}</b></span>`
      : `{{c1::${split.value}}}`;
    return cloze + split.rest;
  });
}

// ── Clean (deterministic artifact fixes) ──────────────────────────────────────
// Fixes generation artifacts in a stored front/extra HTML string:
//   **markdown bold**      → <b>HTML bold</b>
//   em-dashes / `--`       → plain hyphen (` — ` → ` - `)
//   lone `|` sentinels     → removed (leading/trailing/own-line footer artifact)
//   `* ` bullet markers    → `• `
//   bare {{c1::..}} clozes → the styled span form
// Conservative: mid-sentence pipes and unpaired `**` are left untouched.

const STYLED_CLOZE_RE = /<span style="color:#1f77b4"><b>\{\{c\d+::[\s\S]*?\}\}<\/b><\/span>/g;

export function cleanFront(html: string): string {
  let out = html;
  // Markdown bold → HTML bold.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  // Em-dashes and double hyphens → plain hyphen (spaced form keeps its spaces).
  out = out.replace(/ — /g, ' - ');
  out = out.replace(/—|--/g, '-');
  // Lone pipe sentinels: leading, trailing, or on a line of their own.
  out = out.replace(/^\s*\|\s*/, '');
  out = out.replace(/\s*\|\s*$/, '');
  out = out.replace(/\n[ \t]*\|[ \t]*\n/g, '\n');
  // `* ` bullet markers → `• ` (at start of string / line / after <br>).
  out = out.replace(/(^|\n|<br\s*\/?>)[ \t]*\*[ \t]+/g, '$1• ');
  // Bare clozes → styled span form (already-wrapped ones pass through).
  out = out.replace(CLOZE_SPAN_RE, (whole, styledBody?: string, bareBody?: string) =>
    styledBody !== undefined
      ? whole
      : `<span style="color:#1f77b4"><b>{{c1::${bareBody}}}</b></span>`
  );
  return out;
}

// True when cleanFront would change anything — gates the Clean button.
export function needsClean(html: string): boolean {
  if (/\*\*[^*]+\*\*/.test(html)) return true; // markdown bold
  if (/—|--/.test(html)) return true; // em-dash / double hyphen
  if (/^\s*\|/.test(html) || /\|\s*$/.test(html) || /\n[ \t]*\|[ \t]*\n/.test(html)) return true; // lone pipes
  if (/(^|\n|<br\s*\/?>)[ \t]*\*[ \t]+/.test(html)) return true; // * bullets
  return /\{\{c\d+::/.test(html.replace(STYLED_CLOZE_RE, '')); // bare unwrapped cloze
}

// Count `{{c1::..}}` cloze markers in a stored-HTML string. Used to reject a
// Reword result that dropped or invented a cloze.
export function countClozes(html: string): number {
  return (html.match(/\{\{c\d+::/g) ?? []).length;
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
export function toEditorHtml(frontHtml: string, ankiMode = true): string {
  let out = frontHtml;

  // 1) Wrapped cloze: <span ...><b>{{c1::..}}</b></span> (optional <b>).
  out = out.replace(
    /<span[^>]*>(?:<b>)?\{\{c\d+::([\s\S]*?)\}\}(?:<\/b>)?<\/span>/g,
    (_m, body: string) => clozeSpan(body, ankiMode)
  );

  // 2) Any remaining bare cloze markers.
  out = out.replace(/\{\{c\d+::([\s\S]*?)\}\}/g, (_m, body: string) => clozeSpan(body, ankiMode));

  return out;
}

// Build an editor cloze span from a cloze body ("TERM" or "TERM::HINT").
//   ANKI mode: visible text is the TERM; the hint rides along in data-hint.
//   TEXT mode: visible text is the literal `{{c1::BODY}}` (braces carry the
//     hint, so no data-hint is needed) — round-trips via auto-detect on save.
function clozeSpan(body: string, ankiMode = true): string {
  if (!ankiMode) {
    return `<span class="cz" style="color:#1f77b4;font-weight:700">${escapeHtml(`{{c1::${body}}}`)}</span>`;
  }
  const sep = body.indexOf('::');
  const term = sep === -1 ? body : body.slice(0, sep);
  const hint = sep === -1 ? '' : body.slice(sep + 2);
  return `<span class="cz" data-hint="${escapeAttr(hint)}" style="color:#1f77b4;font-weight:700">${escapeHtml(term)}</span>`;
}

// Matches a full `{{cN::BODY}}` string (TEXT-mode span text). Group 1 = BODY.
const TEXT_CLOZE_RE = /^\s*\{\{c\d+::([\s\S]*)\}\}\s*$/;

// Compute the stored cloze BODY from a `.cz` editor span, auto-detecting which
// display mode produced it. Shared by fromEditorHtml (CardEditPopup) and
// serializeExtra (MultiExtraEditModal) so save is mode-agnostic.
export function clozeBodyFromSpan(el: HTMLElement): string {
  const text = el.textContent ?? '';
  const m = text.match(TEXT_CLOZE_RE);
  if (m) return m[1]; // TEXT-mode form: braces already carry the body (+hint).
  const hint = el.getAttribute('data-hint') ?? '';
  return hint ? `${text}::${hint}` : text; // ANKI-mode form.
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

  // Cloze span → stored cloze markup. AUTO-DETECT the display mode from the
  // span's own text so save is identical in TEXT and ANKI mode (no mode param):
  //   TEXT mode span text is `{{c1::BODY}}` → BODY is the captured group.
  //   ANKI mode span text is the TERM → BODY re-appends ::hint if present.
  if (el.classList.contains('cz')) {
    return `<span style="color:#1f77b4"><b>{{c1::${clozeBodyFromSpan(el)}}}</b></span>`;
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
  ankiMode: boolean; // drives cloze display: true = rendered TERM, false = {{c1::..}}
  onSplit?: () => void;
  onDelete?: () => void;
  onClose: () => void;
}

// The correct patch key for the active version's front column.
function frontPatchKey(ver: CardVersion): string {
  return ver === 'v1' ? 'front_html_v1' : ver === 'v2' ? 'front_html_v2' : ver === 'v3' ? 'front_html_v3' : 'front_html';
}

// The correct patch key for the active version's extra column.
function extraPatchKey(ver: CardVersion): string {
  return ver === 'v1' ? 'extra_v1' : ver === 'v2' ? 'extra_v2' : ver === 'v3' ? 'extra_v3' : 'extra';
}

// ── Selection / DOM helpers ───────────────────────────────────────────────────

// The nearest ancestor <b> (that is NOT a cloze span) of a node, bounded by the
// editor root. Returns null if none.
export function boldAncestor(node: Node | null, root: HTMLElement): HTMLElement | null {
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
export function clozeAncestor(node: Node | null, root: HTMLElement): HTMLElement | null {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).classList.contains('cz')) {
      return n as HTMLElement;
    }
    n = n.parentNode;
  }
  return null;
}

// True only when the selection has prose to rephrase — some plain text OUTSIDE
// any bold or cloze. If it's entirely one bold word, one cloze, or only
// bold/cloze content, there's nothing to reword and Reword must skip (bold and
// cloze terms are preserved, never rephrased).
export function hasRewordableProse(range: Range, root: HTMLElement): boolean {
  const sB = boldAncestor(range.startContainer, root);
  const eB = boldAncestor(range.endContainer, root);
  if (sB && sB === eB) return false; // entirely inside one bold
  const sC = clozeAncestor(range.startContainer, root);
  const eC = clozeAncestor(range.endContainer, root);
  if (sC && sC === eC) return false; // entirely inside one cloze
  const holder = document.createElement('div');
  holder.appendChild(range.cloneContents());
  holder.querySelectorAll('.cz, b, strong').forEach((el) => el.remove());
  return (holder.textContent ?? '').trim().length > 0;
}

// Does [range] touch any bold (non-cloze) content? Used for BOLD/UNBOLD mode.
export function rangeHasBold(range: Range, root: HTMLElement): boolean {
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
export function rangeHasCloze(range: Range, root: HTMLElement): HTMLElement | null {
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

// ── Small DOM utilities (module-level, root-scoped, no React state) ────────────
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

// ── Bold / Cloze mutation cores (pure DOM, no React state, no undo) ────────────
// These are the exact split/unwrap-or-wrap and cloze/uncloze algorithms the
// popup uses. The popup's handleBold/handleCloze wrap these with pushUndo +
// refreshSelectionState; the mini-editor calls them directly.

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

// Toggle bold on [range]: unbold if it touches bold, else bold it. No-op on a
// collapsed range. This is the exact DOM core the popup's handleBold runs.
export function applyBoldToRange(root: HTMLElement, range: Range): void {
  if (range.collapsed) return;
  if (rangeHasBold(range, root)) unboldRange(range, root);
  else boldRange(range, root);
}

// Toggle cloze on [range]: uncloze if it touches a cloze span, else cloze the
// selection (whole-cloze atomic; guards empty + nested). This is the exact DOM
// core the popup's handleCloze runs, minus its React/undo wrappers.
export function toggleClozeOnRange(root: HTMLElement, range: Range, ankiMode = true): void {
  const existing = rangeHasCloze(range, root);
  if (existing) {
    // UNCLOZE: replace the span with its brace-free TERM as plain text. In TEXT
    // mode the span text is `{{c1::TERM::hint}}`; strip the wrapper + hint so
    // uncloze leaves `20`, not `{{c1::20}}`.
    const raw = existing.textContent ?? '';
    const m = raw.match(/\{\{c\d+::([\s\S]*?)(?:::[^}]*)?\}\}/);
    const term = m ? m[1] : raw;
    const text = document.createTextNode(term);
    existing.parentNode?.replaceChild(text, existing);
    normalize(root);
    selectNode(text, root);
    return;
  }
  // CLOZE: guard against empty + nested.
  if (range.collapsed) return;
  if (clozeAncestor(range.startContainer, root) || clozeAncestor(range.endContainer, root)) return;
  const contents = range.extractContents();
  if (!contents.textContent) return;
  const span = document.createElement('span');
  span.className = 'cz';
  span.setAttribute('data-hint', '');
  span.setAttribute('style', 'color:#1f77b4;font-weight:700');
  if (ankiMode) {
    // ANKI: visible text is the selected TERM.
    span.appendChild(contents);
  } else {
    // TEXT: visible text is the literal `{{c1::TERM}}` to match the surrounding
    // Text-mode display. Auto-detect on save unwraps it back to the stored form.
    span.textContent = `{{c1::${contents.textContent ?? ''}}}`;
  }
  range.insertNode(span);
  normalize(root);
  selectNodeContents(span, root);
}

type BoldMode = 'bold' | 'unbold';
type ClozeMode = 'cloze' | 'uncloze';
type EditorTab = 'front' | 'extra';

export default function CardEditPopup({ card, onSave, ankiMode, onSplit, onDelete, onClose }: CardEditPopupProps) {
  const { activeCardVersion, selectedModel } = useSettings();
  const ver = activeCardVersion as CardVersion;
  const [tab, setTab] = useState<EditorTab>('front');
  const [hasSelection, setHasSelection] = useState(false);
  const [rewording, setRewording] = useState(false);
  const [rewordHint, setRewordHint] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [guidedOpen, setGuidedOpen] = useState(false);
  const [guidedText, setGuidedText] = useState('');
  const capturedRangeRef = useRef<Range | null>(null);
  const guidedInputRef = useRef<HTMLInputElement>(null);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenPrompt, setRegenPrompt] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState(false);
  const regenInputRef = useRef<HTMLInputElement>(null);
  const [boldMode, setBoldMode] = useState<BoldMode>('bold');
  const [clozeMode, setClozeMode] = useState<ClozeMode>('cloze');
  const [boldEnabled, setBoldEnabled] = useState(false);
  const [frontCleanable, setFrontCleanable] = useState(false);
  const [extraCleanable, setExtraCleanable] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null); // front editor
  const extraRef = useRef<HTMLDivElement>(null);  // extra (footer) editor

  // Per-editor undo stacks: each mutating button/AI op pushes the target
  // editor's innerHTML before it runs; Undo pops and restores. Native
  // contentEditable undo covers plain typing. Reset when the card changes.
  const undoStacks = useRef<{ front: string[]; extra: string[] }>({ front: [], extra: [] });
  const [undoDepth, setUndoDepth] = useState({ front: 0, extra: 0 });

  // Load the draft into the editors when the target card or active version
  // changes (never on background refresh mid-edit — id/version are stable).
  useEffect(() => {
    const el = editorRef.current;
    if (el) el.innerHTML = toEditorHtml(frontFor(card, ver), ankiMode);
    const ex = extraRef.current;
    if (ex) ex.innerHTML = toEditorHtml(extraFor(card, ver), ankiMode);
    setTab('front');
    setHasSelection(false);
    setBoldMode('bold');
    setClozeMode('cloze');
    setBoldEnabled(false);
    setRewordHint(null);
    setGuidedOpen(false);
    setGuidedText('');
    capturedRangeRef.current = null;
    setRegenOpen(false);
    setRegenPrompt('');
    setRegenError(false);
    undoStacks.current = { front: [], extra: [] };
    setUndoDepth({ front: 0, extra: 0 });
    refreshContentState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, ver]);

  // When the global Text/Anki toggle flips while the popup is open, re-render
  // both editors in the new mode without data loss: serialize the current DOM
  // (auto-detect, no mode) then re-render in the new mode. Skips the first run
  // (the load effect above already rendered in the right mode).
  const didMountMode = useRef(false);
  useEffect(() => {
    if (!didMountMode.current) { didMountMode.current = true; return; }
    const el = editorRef.current;
    if (el) el.innerHTML = toEditorHtml(fromEditorHtml(el), ankiMode);
    const ex = extraRef.current;
    if (ex) ex.innerHTML = toEditorHtml(fromEditorHtml(ex), ankiMode);
    refreshSelectionState();
    refreshContentState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ankiMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Which of the two editors (front/extra) contains a node, if either. Lets the
  // selection plumbing work regardless of the active tab (no stale-closure risk
  // in the document-level selectionchange listener).
  function editorRootFor(node: Node): HTMLElement | null {
    const fr = editorRef.current;
    if (fr && fr.contains(node)) return fr;
    const ex = extraRef.current;
    if (ex && ex.contains(node)) return ex;
    return null;
  }

  // Recompute button labels/state from the live selection, but only when the
  // selection is inside one of our editors.
  function refreshSelectionState() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { setHasSelection(false); return; }
    const range = sel.getRangeAt(0);
    const root = editorRootFor(range.commonAncestorContainer);
    if (!root) return; // selection elsewhere

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

  // Get the active range if it lives inside one of the editors (with its root).
  function editorRange(): { root: HTMLElement; range: Range } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const root = editorRootFor(range.commonAncestorContainer);
    if (!root) return null;
    return { root, range };
  }

  // Recompute content-derived button state: Clean gating per editor.
  function refreshContentState() {
    const fr = editorRef.current;
    if (fr) setFrontCleanable(needsClean(fromEditorHtml(fr)));
    const ex = extraRef.current;
    if (ex) setExtraCleanable(needsClean(fromEditorHtml(ex)));
  }

  // ── Undo ──────────────────────────────────────────────────────────────────────
  // Snapshot an editor's innerHTML before a mutating op so Undo can restore it.
  function pushUndo(which: EditorTab) {
    const root = which === 'extra' ? extraRef.current : editorRef.current;
    if (!root) return;
    undoStacks.current[which].push(root.innerHTML);
    setUndoDepth((d) => ({ ...d, [which]: undoStacks.current[which].length }));
  }

  // Restore the active editor's most recent snapshot.
  function handleUndo() {
    const which = tab;
    const stack = undoStacks.current[which];
    if (stack.length === 0) return;
    const root = which === 'extra' ? extraRef.current : editorRef.current;
    if (!root) return;
    root.innerHTML = stack.pop() as string;
    setUndoDepth((d) => ({ ...d, [which]: stack.length }));
    refreshSelectionState();
    refreshContentState();
  }

  // ── Bold / Unbold ───────────────────────────────────────────────────────────
  // Wrapper around the module-level applyBoldToRange DOM core: adds the popup's
  // undo snapshot + selection-state refresh. The mutation itself is identical.
  function handleBold() {
    const er = editorRange();
    if (!er || er.range.collapsed) return;
    const { root, range } = er;
    pushUndo(root === extraRef.current ? 'extra' : 'front');
    applyBoldToRange(root, range);
    refreshSelectionState();
  }

  // ── Cloze / Uncloze ───────────────────────────────────────────────────────────
  // Wrapper around the module-level toggleClozeOnRange DOM core. Pushes undo
  // only when a mutation will actually happen (matches the old behavior: a
  // no-op cloze on an empty/nested range leaves the undo stack untouched).
  function handleCloze() {
    const er = editorRange();
    if (!er) return;
    const { root, range } = er;

    const existing = rangeHasCloze(range, root);
    if (!existing) {
      // Same guards toggleClozeOnRange applies — check them here so we don't
      // push an undo snapshot for a no-op.
      if (range.collapsed) return;
      if (clozeAncestor(range.startContainer, root) || clozeAncestor(range.endContainer, root)) return;
    }
    pushUndo(root === extraRef.current ? 'extra' : 'front');
    toggleClozeOnRange(root, range, ankiMode);
    refreshSelectionState();
  }

  // ── Reword ────────────────────────────────────────────────────────────────────
  // Shared core: rephrase the prose in [range] while preserving clozes/bold.
  // Serializes the range to stored HTML, calls the backend (with optional
  // guidance), runs the cloze-count safety check, and re-inserts the result.
  // Plain Reword passes no guidance; Guided Reword passes the typed instruction.
  async function executeReword(range: Range, guidance?: string) {
    const root = editorRootFor(range.commonAncestorContainer);
    if (!root || range.collapsed || !range.toString().trim()) return;
    // Bold and cloze terms are never reworded. If the selection is only a bold
    // word or a cloze (no surrounding prose), there's nothing to rephrase — skip.
    if (!hasRewordableProse(range, root)) {
      setRewordHint('That selection is a bold/cloze term — nothing to reword.');
      setTimeout(() => setRewordHint(null), 2500);
      return;
    }

    // Selection → stored HTML (clozes/bold intact).
    const holder = document.createElement('div');
    holder.appendChild(range.cloneContents());
    const snippetHtml = fromEditorHtml(holder);
    // Preserve the selection's leading/trailing whitespace — the model trims it,
    // which would otherwise glue the reworded text to its neighbouring words.
    const selText = range.toString();
    const leadWS = selText.match(/^\s*/)?.[0] ?? '';
    const trailWS = selText.match(/\s*$/)?.[0] ?? '';

    setRewordHint(null);
    setRewording(true);
    try {
      const { reworded } = await rewordSnippet(editorText(), snippetHtml, undefined, guidance || undefined);
      // Safety: refuse a result that dropped or added a cloze.
      if (countClozes(reworded) !== countClozes(snippetHtml)) {
        setRewordHint('Reword changed the clozes — left as-is.');
        setTimeout(() => setRewordHint(null), 2000);
        return;
      }
      pushUndo('front');
      // Parse the marked-up result into editor nodes and swap it in.
      const parsed = document.createElement('div');
      parsed.innerHTML = toEditorHtml(leadWS + reworded.trim() + trailWS, ankiMode);
      const frag = document.createDocumentFragment();
      while (parsed.firstChild) frag.appendChild(parsed.firstChild);
      range.deleteContents();
      range.insertNode(frag);
      normalize(root);
    } catch {
      /* leave the text untouched on failure */
    } finally {
      setRewording(false);
      refreshSelectionState();
      refreshContentState();
    }
  }

  // Plain Reword — operates on the live selection.
  async function handleReword() {
    const er = editorRange();
    if (!er || er.range.collapsed) return;
    await executeReword(er.range);
  }

  // Guided Reword — capture the current selection Range BEFORE the input steals
  // focus, then reveal the inline instruction row. The DOM is not mutated while
  // the user types, so the captured Range stays valid.
  function handleGuidedRewordOpen() {
    const er = editorRange();
    if (!er || er.range.collapsed) return;
    if (!hasRewordableProse(er.range, er.root)) {
      setRewordHint('That selection is a bold/cloze term — nothing to reword.');
      setTimeout(() => setRewordHint(null), 2500);
      return;
    }
    capturedRangeRef.current = er.range.cloneRange();
    setGuidedText('');
    setGuidedOpen(true);
    // Focus the input after the state update renders it.
    setTimeout(() => guidedInputRef.current?.focus(), 0);
  }

  function handleGuidedRewordCancel() {
    setGuidedOpen(false);
    setGuidedText('');
    capturedRangeRef.current = null;
  }

  async function handleGuidedRewordGo() {
    const range = capturedRangeRef.current;
    if (!range) return;
    await executeReword(range, guidedText.trim());
    setGuidedOpen(false);
    setGuidedText('');
    capturedRangeRef.current = null;
  }

  // ── Regenerate (inline, unsaved) ──────────────────────────────────────────────
  // Clicking "Regenerate" in the Card group toggles an inline prompt row. On Go,
  // the preview result is loaded into the editors with pushUndo so Undo works.
  // Nothing is saved; the user reviews the result in the editor and hits Save.

  function handleRegenOpen() {
    setRegenError(false);
    setRegenPrompt('');
    setRegenOpen(true);
    setTimeout(() => regenInputRef.current?.focus(), 0);
  }

  function handleRegenCancel() {
    setRegenOpen(false);
    setRegenPrompt('');
    setRegenError(false);
  }

  async function handleRegenGo() {
    setRegenerating(true);
    setRegenError(false);
    try {
      const { front_html, extra } = await regenerateCardPreview(card.id, {
        model: selectedModel,
        prompt: regenPrompt.trim() || undefined,
        card_version: ver,
      });
      // Load front into the front editor with undo support.
      const frontEl = editorRef.current;
      if (frontEl) {
        pushUndo('front');
        frontEl.innerHTML = toEditorHtml(front_html, ankiMode);
      }
      // Load extra only when the API returned a non-null value.
      if (extra !== null) {
        const extraEl = extraRef.current;
        if (extraEl) {
          pushUndo('extra');
          extraEl.innerHTML = toEditorHtml(extra || '', ankiMode);
        }
      }
      refreshSelectionState();
      refreshContentState();
      // Close the inline row and clear the prompt — result is now in the editor.
      setRegenOpen(false);
      setRegenPrompt('');
    } catch {
      setRegenError(true);
      setTimeout(() => setRegenError(false), 3000);
    } finally {
      setRegenerating(false);
    }
  }

  // ── Units out ─────────────────────────────────────────────────────────────────
  // Operate on the canonical stored string, then re-render into the editor.
  function handleUnitsOut() {
    const root = editorRef.current;
    if (!root) return;
    pushUndo('front');
    const stored = fromEditorHtml(root);
    root.innerHTML = toEditorHtml(unitsOut(stored), ankiMode);
    refreshSelectionState();
    refreshContentState();
  }

  // ── Clean ─────────────────────────────────────────────────────────────────────
  // Deterministic artifact fixes on the active tab's editor (see cleanFront).
  function handleClean() {
    const which = tab;
    const root = which === 'extra' ? extraRef.current : editorRef.current;
    if (!root) return;
    pushUndo(which);
    root.innerHTML = toEditorHtml(cleanFront(fromEditorHtml(root)), ankiMode);
    refreshSelectionState();
    refreshContentState();
  }

  // ── Save ──────────────────────────────────────────────────────────────────────
  // Both editors stay mounted (the inactive tab is just hidden), so we always
  // persist both current serialized values for the active version.
  async function handleSave() {
    const root = editorRef.current;
    const ex = extraRef.current;
    if (!root || !ex) return;
    const extraVal = fromEditorHtml(ex);
    await onSave(card.id, {
      [frontPatchKey(ver)]: fromEditorHtml(root),
      [extraPatchKey(ver)]: extraVal.trim() ? extraVal : null,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    // Persist first, then close (deselects + hides the popup). Only reached on
    // a successful save — a throw above skips this.
    onClose();
  }

  const canUndo = undoDepth[tab] > 0;

  return (
    <div className="fixed right-4 top-24 w-[640px] max-w-[calc(100vw-2rem)] z-40 bg-white rounded-xl border border-gray-200 shadow-2xl flex flex-col max-h-[85vh]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <span className="text-base font-semibold text-gray-900">
          Edit card #{card.card_number}
          {ver !== 'base' && (
            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 font-semibold uppercase">{ver}</span>
          )}
        </span>
        <button onClick={onClose} className="p-1.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-50 text-lg leading-none" title="Close (Esc)">✕</button>
      </div>

      <div className="p-4 flex flex-col gap-2 overflow-auto">
        {/* WYSIWYG editors: bold shows bold, clozes show as blue-bold terms.
            Both stay mounted; the tab switch just hides the inactive one so
            drafts survive tab flips and Save can serialize both. */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            {(['front', 'extra'] as const).map((t) => (
              <button
                key={t}
                onClick={() => { setTab(t); refreshContentState(); }}
                className={`px-3 py-1 text-[11px] font-semibold uppercase tracking-wide rounded transition-colors duration-150 ${
                  tab === t ? 'bg-gray-900 text-white' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
                }`}
              >
                {t === 'front' ? 'Front' : 'Extra'}
              </button>
            ))}
          </div>
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onMouseUp={() => { refreshSelectionState(); refreshContentState(); }}
            onKeyUp={() => { refreshSelectionState(); refreshContentState(); }}
            className={`${tab === 'front' ? '' : 'hidden '}w-full min-h-[220px] text-base leading-relaxed text-gray-800 border border-gray-200 rounded-lg px-3.5 py-3 whitespace-pre-wrap focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent`}
          />
          <div
            ref={extraRef}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onMouseUp={() => { refreshSelectionState(); refreshContentState(); }}
            onKeyUp={() => { refreshSelectionState(); refreshContentState(); }}
            className={`${tab === 'extra' ? '' : 'hidden '}w-full min-h-[220px] text-base leading-relaxed text-gray-800 border border-gray-200 rounded-lg px-3.5 py-3 whitespace-pre-wrap focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent`}
          />
        </div>

        {/* ── Format (deterministic) ── */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Format</span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleBold}
              disabled={!boldEnabled}
              title={boldMode === 'unbold' ? 'Remove bold from the selection' : 'Bold the selection'}
              className="min-w-[84px] text-center px-3 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
            >
              {boldMode === 'unbold' ? 'Unbold' : 'Bold'}
            </button>
            {tab === 'front' && (
              <>
                <button
                  onClick={handleCloze}
                  disabled={clozeMode === 'cloze' && !hasSelection}
                  title={clozeMode === 'uncloze' ? 'Remove the cloze from the selection' : 'Cloze the selection'}
                  className="min-w-[84px] text-center px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
                >
                  {clozeMode === 'uncloze' ? 'Uncloze' : 'Cloze'}
                </button>
                <button
                  onClick={handleUnitsOut}
                  title="Move a trailing unit outside the cloze, e.g. {{c1::20 years}} → {{c1::20}} years."
                  className="ml-[120px] px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
                >
                  Units out
                </button>
              </>
            )}
            <button
              onClick={handleClean}
              disabled={!(tab === 'extra' ? extraCleanable : frontCleanable)}
              title="Fix **markdown bold**, em-dashes/--, stray | markers, * bullets, and bare {{c1::..}} clozes"
              className={`${tab === 'front' ? '' : 'ml-4 '}px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150`}
            >
              Clean
            </button>
          </div>
        </div>

        {/* ── AI ── */}
        {tab === 'front' && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">AI</span>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative inline-flex">
                <button
                  onClick={handleReword}
                  disabled={!hasSelection || rewording || guidedOpen}
                  title={hasSelection ? 'Rephrase the selected prose (clozes and bold preserved)' : 'Select text to reword'}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-r-0 border-gray-200 rounded-l-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
                >
                  {rewording && !guidedOpen && <span className="inline-block w-3.5 h-3.5 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />}
                  Reword
                </button>
                <button
                  onClick={handleGuidedRewordOpen}
                  disabled={!hasSelection || rewording || guidedOpen}
                  title={hasSelection ? 'Guided reword — add an instruction for how to rephrase' : 'Select text to guided-reword'}
                  className="px-2.5 py-2 text-sm font-bold italic text-gray-700 bg-white border border-gray-200 rounded-r-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
                >
                  g
                </button>
                <span className="absolute -top-1.5 -right-1.5 px-1 text-[9px] font-bold leading-tight rounded-full bg-violet-600 text-white shadow-sm">AI</span>
              </div>
              {rewordHint && (
                <span className="text-xs text-amber-600">{rewordHint}</span>
              )}
            </div>
            {guidedOpen && (
              <div className="flex items-center gap-2 mt-1">
                <input
                  ref={guidedInputRef}
                  type="text"
                  value={guidedText}
                  onChange={(e) => setGuidedText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); handleGuidedRewordGo(); }
                    if (e.key === 'Escape') { e.preventDefault(); handleGuidedRewordCancel(); }
                  }}
                  placeholder="How should it be reworded? e.g. don't use a semicolon, make it flow"
                  className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent"
                />
                <button
                  onClick={handleGuidedRewordGo}
                  disabled={rewording}
                  title="Apply guided reword"
                  className="relative inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
                >
                  {rewording && <span className="inline-block w-3.5 h-3.5 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />}
                  Reword
                </button>
                <button
                  onClick={handleGuidedRewordCancel}
                  title="Cancel"
                  className="px-2 py-1.5 text-sm font-medium text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
                >
                  ×
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Card ── */}
        {tab === 'front' && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Card</span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleRegenOpen}
                disabled={regenOpen || regenerating}
                title="Regenerate this card — result lands in the editor unsaved so you can review and Undo"
                className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
              >
                Regenerate
              </button>
              {onSplit && (
                <button
                  onClick={onSplit}
                  title="Split this card into multiple focused cards"
                  className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
                >
                  Split
                </button>
              )}
            </div>
            {regenOpen && (
              <div className="flex items-center gap-2 mt-1">
                <input
                  ref={regenInputRef}
                  type="text"
                  value={regenPrompt}
                  onChange={(e) => setRegenPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); handleRegenGo(); }
                    if (e.key === 'Escape') { e.preventDefault(); handleRegenCancel(); }
                  }}
                  placeholder="How to regenerate? (optional guidance)"
                  className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent"
                />
                <button
                  onClick={handleRegenGo}
                  disabled={regenerating}
                  title="Run regenerate"
                  className="relative inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
                >
                  {regenerating && <span className="inline-block w-3.5 h-3.5 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />}
                  Regenerate
                </button>
                <button
                  onClick={handleRegenCancel}
                  title="Cancel"
                  className="px-2 py-1.5 text-sm font-medium text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
                >
                  ×
                </button>
                {regenError && (
                  <span className="text-xs text-red-600">Regenerate failed</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Undo + Save / Close ── */}
        <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
          <button
            onClick={handleUndo}
            disabled={!canUndo}
            title={canUndo ? 'Undo the last button/AI change' : 'Nothing to undo'}
            className="px-2 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
          >
            Undo
          </button>
          {onDelete && (
            <button
              onClick={onDelete}
              title="Delete this card"
              className="px-2 py-1 text-xs font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors duration-150"
            >
              Delete
            </button>
          )}
          <button
            onClick={onClose}
            className="ml-auto px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
          >
            Close
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors duration-150"
          >
            {saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
