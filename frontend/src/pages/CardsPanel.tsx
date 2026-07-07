import { useEffect, useState, useRef, useCallback, useMemo, useDeferredValue } from 'react';
import { createPortal } from 'react-dom';
import type { ColumnSizingState, PaginationState, VisibilityState } from '@tanstack/react-table';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from '@tanstack/react-table';
import {
  getCards,
  updateCard,
  rejectCard,
  deleteCard,
  regenerateCard,
  regenerateCardPreview,
  exportCardsUrl,
  deleteSectionImage,
  bulkMarkReviewed,
  bulkDeleteCards,
  estimateCost,
  startGeneration,
  getGenerationJob,
  cancelGenerationJob,
  getActiveJobs,
  startSupplemental,
  getReviewMarkTypes,
  createReviewMarkType,
  bulkMarkCards,
  bulkScoreCards,
  validateCards,
  getValidationRules,
  revertValidation,
  createFixBatch,
  getFixBatch,
  confirmFixBatch,
  cancelFixBatch,
  updateFixProposalContent,
  combinePreview,
  combineApply,
  type CombineProposal,
  getSection,
  uploadSectionImage,
  uploadSectionImageFromUrl,
  debugPromptSection,
  debugRunSection,
  getModels,
  addManualCards,
  getRuleSets,
  type DebugPromptResult,
  type DebugRunResult,
} from '../api';
import type { Card, CardStatus, CostEstimate, ReviewMarkType, SectionImage, FixProposal, Model, RuleSet } from '../types';
import { loadRegenHistory, pushSnapshots, rollbackToIndex, type RegenHistory } from '../regenHistory';
import ConfirmModal from '../components/ConfirmModal';
import SbsGenerateModal from '../components/SbsGenerateModal';
import AlertModal from '../components/AlertModal';
import AnkifyModal from '../components/AnkifyModal';
import CreatePresentationModal from '../components/CreatePresentationModal';
import SectionViewer from './SectionViewer';
import { useSettings } from '../context/SettingsContext';

interface CardsPanelProps {
  sectionId: number | null;
  topicPath?: string | null;
  sectionIds?: number[] | null;
  topicTreeId?: number | null;
  refreshKey?: number;
  refreshUsage?: () => void;
  onReviewChange?: () => void;
}

const columnHelper = createColumnHelper<Card>();

// Cards loaded per page (server-side pagination). Sections usually top out
// around ~70 cards, so 80 grabs them all in one request. Single source of
// truth — used for the initial page size and any page-size logic.
const CARDS_PAGE_SIZE = 80;

// Delimiter between a card's tags everywhere they're shown/serialized as a
// string (Anki-style hierarchical, no surrounding spaces). Individual tags
// contain commas, so comma can't be the separator.
const TAG_SEP = '::';
const joinTags = (tags: string[]) => tags.join(TAG_SEP);
const splitTags = (s: string) => s.split(TAG_SEP).map(t => t.trim()).filter(Boolean);

// Quick-pick palette for creating a review mark inline from the Actions menu.
const MARK_COLORS = ['#6b7280', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'];

// ── Cloze rendering utility ────────────────────────────────────────────────────
function renderClozeHtml(html: string): string {
  let result = html.replace(
    /(?:<b>)?<span[^>]*>\{\{c\d+::([^}]+)\}\}<\/span>(?:<\/b>)?/g,
    '<span style="color:#1f77b4;font-weight:700">$1</span>'
  );
  result = result.replace(
    /\{\{c\d+::([^}]+)\}\}/g,
    '<span style="color:#1f77b4;font-weight:700">$1</span>'
  );
  return result;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ── EditableCell ───────────────────────────────────────────────────────────────
interface EditableCellProps {
  value: string;
  cellId: string;
  onSave: (val: string) => void;
  onSelect: (cellId: string) => void;
  onNavigate: (dir: 'up' | 'down' | 'left' | 'right') => void;
  multiline?: boolean;
  renderDisplay?: (val: string) => React.ReactNode;
}

function EditableCell({ value, cellId, onSave, onSelect, onNavigate, multiline, renderDisplay }: EditableCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [localVal, setLocalVal] = useState(value);
  // Anchor (viewport coords) for the floating multiline edit box, captured when
  // editing starts so the box escapes the narrow column / cell clipping.
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const cellRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setLocalVal(value); }, [value]);

  const BOX_W = 540;   // comfortable editing width
  const BOX_H = 240;   // fixed height with internal scroll — no more runaway tallness

  function startEdit() {
    setLocalVal(value);
    if (multiline) {
      const r = cellRef.current?.getBoundingClientRect();
      if (r) {
        // Keep clear of the screen edges: ≥100px from the right, ≥50px from
        // the bottom. The box is fixed-height with overflow-auto, so longer
        // content scrolls inside rather than growing.
        const width = Math.min(Math.max(r.width, BOX_W), window.innerWidth - 24);
        const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 100));
        const top = Math.max(8, Math.min(r.top - 2, window.innerHeight - BOX_H - 50));
        setBox({ left, top, width });
      }
    }
    setIsEditing(true);
  }
  function save() { setIsEditing(false); if (localVal !== value) onSave(localVal); }
  function cancel() { setIsEditing(false); setLocalVal(value); }

  if (isEditing && multiline) {
    return (
      <>
        {/* keep the row height stable while the editor floats above */}
        <div className="min-h-[1.5em]" />
        <textarea
          ref={taRef}
          className="fixed z-50 bg-white border border-blue-400 rounded-lg shadow-2xl p-3 text-sm leading-relaxed outline-none resize overflow-auto"
          style={{ left: box?.left ?? 0, top: box?.top ?? 0, width: box?.width ?? BOX_W, height: BOX_H }}
          value={localVal}
          onChange={(e) => setLocalVal(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            if (e.key === 'Tab') { e.preventDefault(); save(); }
          }}
          autoFocus
        />
      </>
    );
  }

  if (isEditing) {
    return (
      <input
        type="text"
        className="w-full text-sm bg-white border-0 outline-none p-0 leading-relaxed"
        value={localVal}
        onChange={(e) => setLocalVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); save(); }
        }}
        autoFocus
      />
    );
  }

  return (
    <div
      ref={cellRef}
      data-cell-id={cellId}
      tabIndex={0}
      className="cursor-default outline-none w-full h-full min-h-[1.5em]"
      onClick={() => onSelect(cellId)}
      onDoubleClick={startEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); startEdit(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); onNavigate('up'); }
        if (e.key === 'ArrowDown') { e.preventDefault(); onNavigate('down'); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); onNavigate('left'); }
        if (e.key === 'ArrowRight') { e.preventDefault(); onNavigate('right'); }
      }}
    >
      {renderDisplay ? renderDisplay(value) : (
        value
          ? <span className="text-sm text-gray-700">{value}</span>
          : <span className="text-gray-300 text-xs">—</span>
      )}
    </div>
  );
}

// ── BigEditModal — large popup editor for long text fields ───────────────────
type CardVersion = 'base' | 'v1' | 'v2' | 'v3';
const EDIT_TABS: { key: string; label: string }[] = [
  { key: 'front_html', label: 'Card Text' },
  { key: 'extra', label: 'Extra' },
  { key: 'tags', label: 'Tags' },
  { key: 'vignette', label: 'Vignette' },
  { key: 'teaching_case', label: 'Teaching Case' },
];

function frontFieldFor(v: CardVersion): string {
  return v === 'v1' ? 'front_html_v1' : v === 'v2' ? 'front_html_v2' : v === 'v3' ? 'front_html_v3' : 'front_html';
}
function extraFieldFor(v: CardVersion): string {
  return v === 'v1' ? 'extra_v1' : v === 'v2' ? 'extra_v2' : v === 'v3' ? 'extra_v3' : 'extra';
}
function getFieldValue(card: Card, key: string, ver: CardVersion): string {
  // Each version is independent — NO base fallback. An empty version column shows
  // empty (you fill it by generating/editing that version), never the base text.
  if (key === 'front_html') {
    if (ver === 'base') return card.front_html ?? '';
    return (((card as any)[frontFieldFor(ver)]) ?? '') as string;
  }
  if (key === 'extra') {
    if (ver === 'base') return card.extra ?? '';
    return (((card as any)[extraFieldFor(ver)]) ?? '') as string;
  }
  return (((card as any)[key]) ?? '') as string;
}
// The active version's accuracy/yield score. A score reflects the specific text
// that was scored, so we do NOT fall back to base: a version that hasn't been
// scored yet returns null and the badge simply hides (matches an unscored base card).
function scoreFor(card: Card, ver: CardVersion): { score: number | null; note: string | null; eor: Record<string, string> | null } {
  if (ver === 'base') return { score: card.accuracy_score, note: card.accuracy_note, eor: card.eor_yield };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = card as any;
  return { score: c[`accuracy_score_${ver}`] ?? null, note: c[`accuracy_note_${ver}`] ?? null, eor: c[`eor_yield_${ver}`] ?? null };
}
// The active version's validator (X/N) score. Like the accuracy score, this
// reflects the specific text validated, so we do NOT fall back to base: an
// unvalidated version returns null and the badge hides.
function correctnessFor(card: Card, ver: CardVersion): { score: number | null; data: Card['correctness'] | null } {
  if (ver === 'base') return { score: card.correctness_score ?? null, data: card.correctness ?? null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = card as any;
  return { score: c[`correctness_score_${ver}`] ?? null, data: c[`correctness_${ver}`] ?? null };
}
// The validator change-record for ONE version. validation_change is a per-version
// map ({base, v1, v2, v3}); legacy rows may still be the old flat shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function vcEntryFor(card: Card, ver: CardVersion): any {
  const vc = card.validation_change as any;
  if (!vc) return null;
  if (vc.action) return (vc.version || 'base') === ver ? vc : null;  // legacy flat shape
  return vc[ver] || null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fieldPatch(key: string, val: string, ver: CardVersion): any {
  if (key === 'front_html') return { [frontFieldFor(ver)]: val };
  if (key === 'extra') return { [extraFieldFor(ver)]: val || null };  // versioned extra
  return { [key]: val || null };  // vignette/teaching_case null out when blank
}

interface BigEditModalProps {
  cards: Card[];
  cardId: number;
  field: string;
  activeCardVersion: CardVersion;
  activeTagSet: 'old' | 'new';
  enableCardNav: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSave: (id: number, patch: any) => void;
  onClose: () => void;
}

function BigEditModal({ cards, cardId: startId, field: startField, activeCardVersion, activeTagSet, enableCardNav, onSave, onClose }: BigEditModalProps) {
  const [cardId, setCardId] = useState(startId);
  const [fieldKey, setFieldKey] = useState(startField);
  const [draft, setDraft] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const idx = cards.findIndex((c) => c.id === cardId);
  const card = idx >= 0 ? cards[idx] : undefined;

  // Tags aren't versioned — they're a list keyed by the active tag set
  // (old → tags, new → tags_mapped), shown/edited as a "::"-separated string.
  const tagsString = (c: Card) => joinTags(activeTagSet === 'old' ? (c.tags ?? []) : (c.tags_mapped ?? []));
  const valueFor = (c: Card) => fieldKey === 'tags' ? tagsString(c) : getFieldValue(c, fieldKey, activeCardVersion);

  // Reload the draft when the (card, field) target changes — not on background
  // refreshes, so we never clobber what the user is typing.
  useEffect(() => {
    if (card) setDraft(valueFor(card));
    requestAnimationFrame(() => taRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, fieldKey]);

  if (!card) return null;

  function flush() {
    if (!card) return;
    const orig = valueFor(card);
    if (draft === orig) return;
    if (fieldKey === 'tags') {
      const tags = splitTags(draft);
      onSave(card.id, activeTagSet === 'old' ? { tags } : { tags_mapped: tags });
    } else {
      onSave(card.id, fieldPatch(fieldKey, draft, activeCardVersion));
    }
  }
  function switchField(k: string) { if (k === fieldKey) return; flush(); setFieldKey(k); }
  function gotoCard(dir: -1 | 1) {
    const ni = Math.min(cards.length - 1, Math.max(0, idx + dir));
    if (ni === idx) return;
    flush();
    setCardId(cards[ni].id);
  }
  function saveClose() { flush(); onClose(); }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30" onClick={saveClose} />
      <div
        className="relative bg-white rounded-xl shadow-2xl border border-gray-200 flex flex-col"
        style={{ width: '82vw', maxWidth: '1100px', height: '78vh' }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveClose(); }
        }}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-gray-200">
          <div className="flex items-center gap-1">
            {EDIT_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => switchField(t.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors duration-150 ${fieldKey === t.key ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {enableCardNav && (
              <div className="flex items-center gap-1 text-gray-500">
                <button onClick={() => gotoCard(-1)} disabled={idx <= 0} title="Save & previous card" className="px-1.5 py-1 rounded hover:bg-gray-100 disabled:opacity-30">◀</button>
                <span className="text-[11px] tabular-nums">Card #{card.card_number}</span>
                <button onClick={() => gotoCard(1)} disabled={idx >= cards.length - 1} title="Save & next card" className="px-1.5 py-1 rounded hover:bg-gray-100 disabled:opacity-30">▶</button>
              </div>
            )}
            <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-50" title="Cancel (Esc)">✕</button>
          </div>
        </div>
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="flex-1 w-full resize-none px-4 py-3 text-sm leading-relaxed font-mono text-gray-800 outline-none"
          spellCheck={false}
        />
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-gray-200 bg-gray-50/60">
          <span className="text-[11px] text-gray-400">
            {fieldKey === 'tags'
              ? `Tags for the "${activeTagSet === 'old' ? 'Current' : 'New'}" set — separate with :: (no spaces) · ⌘/Ctrl+Enter saves & closes`
              : 'Click outside or Save keeps changes · Esc cancels · ⌘/Ctrl+Enter saves & closes'}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs font-medium text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
            <button onClick={saveClose} className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">Save &amp; Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Double-click-to-edit field used inside the split/combine review modals.
function ProposalEditableField({ html, onSave, className }: { html: string; onSave: (v: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(html);
  useEffect(() => { setVal(html); }, [html]);
  if (editing) {
    return (
      <textarea
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => { setEditing(false); if (val !== html) onSave(val); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setVal(html); }
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); setEditing(false); if (val !== html) onSave(val); }
        }}
        className="w-full min-h-[90px] text-sm border border-blue-400 rounded p-2 outline-none resize-y font-mono leading-relaxed"
      />
    );
  }
  return (
    <div onDoubleClick={() => { setVal(html); setEditing(true); }} title="Double-click to edit" className={`cursor-text ${className ?? ''}`}>
      {html
        ? <span dangerouslySetInnerHTML={{ __html: html }} />
        : <span className="text-gray-300 italic">— double-click to add —</span>}
    </div>
  );
}

// ── TagsCell — pill-based editor ──────────────────────────────────────────────
interface TagsCellProps {
  tags: string[];
  cellId: string;
  onSave: (tags: string[]) => void;
  onSelect: (cellId: string) => void;
  onNavigate: (dir: 'up' | 'down' | 'left' | 'right') => void;
}

function TagsCell({ tags, cellId, onSave, onSelect, onNavigate }: TagsCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [localTags, setLocalTags] = useState<string[]>(tags);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingVal, setEditingVal] = useState('');
  const [addingNew, setAddingNew] = useState(false);
  const [newTagVal, setNewTagVal] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!isEditing) setLocalTags(tags); }, [tags, isEditing]);

  function startEditing() {
    setLocalTags([...tags]);
    setIsEditing(true);
    requestAnimationFrame(() => containerRef.current?.focus());
  }

  function doSave(final: string[]) {
    setIsEditing(false); setEditingIdx(null); setAddingNew(false);
    setEditingVal(''); setNewTagVal('');
    if (JSON.stringify(final) !== JSON.stringify(tags)) onSave(final);
  }

  function handleContainerBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    let final = [...localTags];
    if (editingIdx !== null) {
      const t = editingVal.trim();
      final = t ? final.map((v, i) => i === editingIdx ? t : v) : final.filter((_, i) => i !== editingIdx);
    }
    if (addingNew && newTagVal.trim()) final = [...final, newTagVal.trim()];
    doSave(final);
  }

  function commitTagEdit(idx: number, val: string) {
    const t = val.trim();
    setLocalTags(t ? localTags.map((v, i) => i === idx ? t : v) : localTags.filter((_, i) => i !== idx));
    setEditingIdx(null); setEditingVal('');
  }

  function commitNewTag(val: string) {
    if (val.trim()) setLocalTags(prev => [...prev, val.trim()]);
    setAddingNew(false); setNewTagVal('');
  }

  if (!isEditing) {
    return (
      <div
        data-cell-id={cellId}
        tabIndex={0}
        onClick={() => onSelect(cellId)}
        onDoubleClick={startEditing}
        onFocus={() => onSelect(cellId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); startEditing(); }
          if (e.key === 'ArrowUp') { e.preventDefault(); onNavigate('up'); }
          if (e.key === 'ArrowDown') { e.preventDefault(); onNavigate('down'); }
          if (e.key === 'ArrowLeft') { e.preventDefault(); onNavigate('left'); }
          if (e.key === 'ArrowRight') { e.preventDefault(); onNavigate('right'); }
        }}
        className="cursor-default outline-none w-full h-full"
        style={{ minHeight: '2rem' }}
      >
        {tags.length === 0
          ? <span className="text-gray-300 text-xs">—</span>
          : <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200 font-medium break-all">{joinTags(tags)}</span>
        }
      </div>
    );
  }

  return (
    <div ref={containerRef} tabIndex={0} className="w-full outline-none" style={{ minHeight: '2rem' }} onBlur={handleContainerBlur}>
      <div className="flex flex-wrap gap-1 items-center">
        {localTags.map((tag, idx) =>
          editingIdx === idx ? (
            <input
              key={idx}
              autoFocus
              value={editingVal}
              onChange={(e) => setEditingVal(e.target.value)}
              onBlur={(e) => {
                if (containerRef.current?.contains(e.relatedTarget as Node | null)) commitTagEdit(idx, editingVal);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitTagEdit(idx, editingVal); }
                if (e.key === 'Escape') { setEditingIdx(null); setEditingVal(''); }
                if (e.key === 'Tab') { e.preventDefault(); commitTagEdit(idx, editingVal); setAddingNew(true); }
              }}
              className="px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-400 outline-none font-medium"
              style={{ width: Math.max(60, editingVal.length * 7 + 20) + 'px' }}
            />
          ) : (
            <span key={idx} className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200 font-medium group/tag">
              <span>{tag}</span>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); setEditingIdx(idx); setEditingVal(tag); }}
                className="ml-0.5 text-blue-400 hover:text-blue-600 opacity-40 group-hover/tag:opacity-100 transition-opacity"
                tabIndex={-1}
                title="Edit tag"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z" />
                </svg>
              </button>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); setLocalTags(prev => prev.filter((_, i) => i !== idx)); }}
                className="text-blue-400 hover:text-red-500 opacity-40 group-hover/tag:opacity-100 transition-opacity"
                tabIndex={-1}
                title="Remove tag"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          )
        )}
        {addingNew ? (
          <input
            autoFocus
            value={newTagVal}
            onChange={(e) => setNewTagVal(e.target.value)}
            onBlur={(e) => {
              if (containerRef.current?.contains(e.relatedTarget as Node | null)) commitNewTag(newTagVal);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitNewTag(newTagVal); }
              if (e.key === 'Escape') { setAddingNew(false); setNewTagVal(''); }
            }}
            placeholder="new tag..."
            className="px-2 py-0.5 rounded text-[11px] bg-white text-gray-700 border border-gray-300 outline-none"
            style={{ width: '80px' }}
          />
        ) : (
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); setAddingNew(true); }}
            className="inline-flex items-center justify-center h-5 px-1.5 rounded text-[11px] text-gray-400 border border-dashed border-gray-300 hover:text-blue-500 hover:border-blue-400 transition-colors"
            tabIndex={-1}
            title="Add tag"
          >
            +
          </button>
        )}
      </div>
    </div>
  );
}

// ── CardTile component ─────────────────────────────────────────────────────────
interface CardTileProps {
  card: Card;
  cardIndex: number;
  onEdit: (card: Card) => void;
  onReject: (id: number) => void;
  onRestore: (id: number) => void;
  onDelete: (id: number) => void;
  editingId: number | null;
  editFrontHtml: string;
  setEditFrontHtml: (v: string) => void;
  editTags: string;
  setEditTags: (v: string) => void;
  onSave: (id: number) => void;
  onCancel: () => void;
  regenLoading: boolean;
  onRegen: (id: number, prompt: string) => void;
  selected: boolean;
  onToggleSelect: (id: number) => void;
  onViewSection: (sectionId: number) => void;
}

function CardTile({
  card,
  cardIndex,
  onEdit,
  onReject,
  onRestore,
  onDelete,
  editingId,
  editFrontHtml,
  setEditFrontHtml,
  editTags,
  setEditTags,
  onSave,
  onCancel,
  regenLoading,
  onRegen,
  selected,
  onToggleSelect,
  onViewSection,
}: CardTileProps) {
  const { activeTagSet } = useSettings();
  const activeTags = activeTagSet === 'old' ? card.tags : (card.tags_mapped ?? []);
  const isEditing = editingId === card.id;
  const isRejected = card.status === 'rejected';
  type PopoverKind = 'tags' | 'actions' | 'regen';
  const [popover, setPopover] = useState<{ kind: PopoverKind; x: number; y: number } | null>(null);
  const [regenPrompt, setRegenPrompt] = useState('');

  function openPopover(kind: PopoverKind, e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    setPopover((prev) => (prev?.kind === kind ? null : { kind, x: rect.left, y: rect.bottom + 4 }));
    if (kind === 'regen') setRegenPrompt('');
  }

  function closePopover() { setPopover(null); }

  return (
    <div
      className={`relative bg-white rounded-xl border transition-all duration-200 flex flex-col ${
        selected ? 'border-blue-400 shadow-md ring-1 ring-blue-300' : 'border-gray-200 shadow-md hover:shadow-lg'
      }${isRejected ? ' opacity-60 bg-gray-50' : ''}`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggleSelect(card.id)}
        className="absolute top-3 left-3 z-10 rounded border-gray-300 text-blue-700 focus:ring-blue-500"
      />

      <div className="pt-3 pl-8 pr-5 pb-4 flex-1" style={{ minHeight: '100px' }}>
        {isEditing ? (
          <div className="flex flex-col gap-2.5">
            <textarea
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-y min-h-[80px] focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors duration-150"
              value={editFrontHtml}
              onChange={(e) => setEditFrontHtml(e.target.value)}
            />
            <input
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors duration-150"
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
              placeholder="tag1::tag2"
            />
            <div className="flex items-center gap-1.5">
              <button onClick={() => onSave(card.id)} className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors duration-150">Save</button>
              <button onClick={onCancel} className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="text-sm leading-relaxed text-gray-800" dangerouslySetInnerHTML={{ __html: renderClozeHtml(card.front_html) }} />
        )}
      </div>

      <div className="border-t border-gray-100 px-3 py-2 bg-gray-50/30 rounded-b-xl flex items-center gap-1.5">
        <span className={`text-xs tabular-nums ${!card.is_reviewed ? 'font-bold text-gray-900' : 'font-normal text-gray-400'}`}>#{cardIndex}</span>
        <div className="flex-1 overflow-hidden">
          {activeTags.length === 0 ? (
            <span className="text-gray-300 text-xs">--</span>
          ) : (
            <button
              onClick={(e) => openPopover('tags', e)}
              title={joinTags(activeTags)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100 transition-colors duration-150"
            >
              <span className="truncate max-w-[140px]">{joinTags(activeTags)}</span>
            </button>
          )}
        </div>
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${isRejected ? 'bg-red-400' : card.is_reviewed ? 'bg-gray-300' : 'bg-amber-400'}`}
          title={isRejected ? 'Rejected' : card.is_reviewed ? 'Reviewed' : 'Not reviewed'}
        />
        <button
          onClick={(e) => openPopover('actions', e)}
          className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors duration-150"
          title="Actions"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
          </svg>
        </button>
      </div>

      {popover && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={closePopover} />
          {popover.kind === 'tags' && (
            <div className="fixed z-50 bg-white border border-gray-200 rounded-xl shadow-xl p-2.5 min-w-[160px] max-w-[240px]" style={{ top: popover.y, left: popover.x }}>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5 px-1">Tags</p>
              <div className="text-[11px] text-blue-700 break-all px-1">{joinTags(activeTags)}</div>
            </div>
          )}
          {popover.kind === 'actions' && (
            <div className="fixed z-50 bg-white border border-gray-200 rounded-xl shadow-xl py-1 min-w-[160px]" style={{ top: popover.y, left: Math.max(8, popover.x - 120) }}>
              <button onClick={() => { closePopover(); onViewSection(card.section_id); }} className="flex items-center gap-2 w-full px-3 py-2 text-xs text-blue-600 hover:bg-blue-50 transition-colors duration-150">View Source Section</button>
              <div className="my-1 border-t border-gray-100" />
              <button onClick={() => { closePopover(); onEdit(card); }} className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 transition-colors duration-150">Edit</button>
              <button onClick={(e) => openPopover('regen', e)} className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 transition-colors duration-150">Regenerate</button>
              {isRejected ? (
                <button onClick={() => { closePopover(); onRestore(card.id); }} className="flex items-center gap-2 w-full px-3 py-2 text-xs text-green-700 hover:bg-green-50 transition-colors duration-150">Restore</button>
              ) : (
                <button onClick={() => { closePopover(); onReject(card.id); }} className="flex items-center gap-2 w-full px-3 py-2 text-xs text-red-600 hover:bg-red-50 transition-colors duration-150">Reject</button>
              )}
              <div className="my-1 border-t border-gray-100" />
              <button onClick={() => { closePopover(); onDelete(card.id); }} className="flex items-center gap-2 w-full px-3 py-2 text-xs text-red-700 hover:bg-red-50 transition-colors duration-150">Delete</button>
            </div>
          )}
          {popover.kind === 'regen' && (
            <div className="fixed z-50 bg-white border border-amber-200 rounded-xl shadow-xl p-3 w-52" style={{ top: popover.y, left: Math.max(8, popover.x - 180) }}>
              <p className="text-[10px] font-semibold text-amber-700 uppercase tracking-wide mb-2">Regenerate card</p>
              <input
                className="w-full text-xs border border-amber-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent bg-amber-50/40 mb-2"
                placeholder="Optional guidance..."
                value={regenPrompt}
                onChange={(e) => setRegenPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { closePopover(); onRegen(card.id, regenPrompt); } if (e.key === 'Escape') closePopover(); }}
                autoFocus
              />
              <div className="flex gap-1.5">
                <button
                  onClick={() => { closePopover(); onRegen(card.id, regenPrompt); }}
                  disabled={regenLoading}
                  className="flex-1 px-2.5 py-1.5 text-xs font-medium text-white bg-amber-500 rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors duration-150"
                >
                  {regenLoading ? 'Working...' : 'Regenerate'}
                </button>
                <button onClick={closePopover} className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-50">Cancel</button>
              </div>
            </div>
          )}
        </>,
        document.body
      )}
    </div>
  );
}

// Pull an http(s) image URL out of a drop's dataTransfer when no File is present
// (image dragged from a browser/app). Tries uri-list, then <img src> in the HTML
// payload, then a bare plaintext URL.
function extractImageUrl(dt: DataTransfer): string | null {
  const uriList = dt.getData('text/uri-list');
  if (uriList) {
    const line = uriList.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (line?.startsWith('http')) return line;
  }
  const html = dt.getData('text/html');
  if (html) {
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m?.[1]?.startsWith('http')) return m[1];
  }
  const plain = dt.getData('text/plain')?.trim();
  if (plain?.startsWith('http')) return plain;
  return null;
}

// ── Image Picker Cell ────────────────────────────────────────────────────────
function ImagePickerCell({
  cardId,
  sectionId,
  currentImg,
  currentImgId,
  currentPosition,
  onUpdate,
}: {
  cardId: number;
  sectionId: number;
  currentImg: string | null;
  currentImgId: number | null;
  currentPosition: string;
  onUpdate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [images, setImages] = useState<SectionImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState<'front' | 'back'>(currentPosition as 'front' | 'back' || 'front');
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const loadImages = async () => {
    setLoading(true);
    try {
      const section = await getSection(sectionId);
      setImages(section.images || []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  const handleOpen = () => {
    setOpen(true);
    loadImages();
  };

  const handleAttach = async (imgId: number) => {
    await updateCard(cardId, { ref_img_id: imgId, ref_img_position: position });
    setOpen(false);
    onUpdate();
  };

  const handleDetach = async () => {
    await updateCard(cardId, { ref_img_id: 0 });
    setOpen(false);
    onUpdate();
  };

  // Shared: upload a file/blob to the section library, then attach it to this card.
  const attachFile = async (file: Blob, pos: 'front' | 'back') => {
    if (file.type && !file.type.startsWith('image/')) {
      setNote('Not an image');
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const img = await uploadSectionImage(sectionId, file);
      await updateCard(cardId, { ref_img_id: img.id, ref_img_position: pos });
      setOpen(false);
      onUpdate();
    } catch {
      setNote('Upload failed');
    } finally {
      setBusy(false);
    }
  };

  // Attach an image dragged from another website/app, where the browser gives us a
  // URL instead of file bytes. The backend fetches it server-side (no CORS).
  const attachUrl = async (url: string, pos: 'front' | 'back') => {
    setBusy(true);
    setNote(null);
    try {
      const img = await uploadSectionImageFromUrl(sectionId, url);
      await updateCard(cardId, { ref_img_id: img.id, ref_img_position: pos });
      setOpen(false);
      onUpdate();
    } catch {
      setNote("Couldn't fetch that image — try saving it and dropping the file");
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await attachFile(file, position);
    e.target.value = ''; // allow re-selecting the same file
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dt = e.dataTransfer;
    const files = Array.from(dt.files);
    // eslint-disable-next-line no-console
    console.log('[ref-img] DROP fired', {
      cardId,
      types: Array.from(dt.types),
      fileCount: files.length,
      files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
      uriList: dt.getData('text/uri-list'),
      plain: dt.getData('text/plain'),
      html: dt.getData('text/html')?.slice(0, 200),
    });
    // Prefer an explicit image file; fall back to the first file (some OSes report
    // an empty MIME type) and let attachFile() do the real validation.
    const file = files.find((f) => f.type.startsWith('image/')) || files[0];
    if (file) { attachFile(file, 'front'); return; }
    // No File means the image was dragged from a browser/website/app — the browser
    // gives us a URL (text/uri-list, or an <img src> inside text/html) instead of the
    // bytes. Send that URL to the backend, which fetches it server-side (no CORS).
    const url = extractImageUrl(dt);
    if (url) { attachUrl(url, 'front'); return; }
    setNote('Could not read a dropped image — try saving it and dropping the file');
  };

  // Paste an image from the clipboard via the Async Clipboard API (button).
  const handlePasteButton = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          await attachFile(blob, position);
          return;
        }
      }
      setNote('No image in clipboard');
    } catch {
      setNote('Press Ctrl+V on the cell instead');
    }
  };

  // Ctrl+V while the cell is hovered or its picker is open.
  useEffect(() => {
    if (!hovered && !open) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith('image/')) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            attachFile(file, open ? position : 'front');
          }
          return;
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered, open, position, sectionId, cardId]);

  // Clear transient note shortly after it appears
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 2500);
    return () => clearTimeout(t);
  }, [note]);

  return (
    <div
      ref={ref}
      // The td is position:relative with zero padding for this column, so inset-0
      // makes the ENTIRE cell the drop zone — at full row height, not just a 40px
      // strip at the top. The image (below) sizes to this box, not a tiny cap.
      className={`absolute inset-0 rounded flex items-center justify-center ${dragOver ? 'ring-2 ring-inset ring-blue-400 bg-blue-50' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!dragOver) setDragOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={handleDrop}
      title="Click to pick · drop or paste (Ctrl+V) an image to attach it"
    >
      <div
        onClick={handleOpen}
        className="w-full h-full min-h-[40px] flex items-center justify-center cursor-pointer p-1"
      >
        {currentImg ? (
          <img src={currentImg} alt="ref" className="max-h-full max-w-full object-contain rounded hover:opacity-80" />
        ) : (
          <span className="text-gray-300 hover:text-blue-400 text-lg">+</span>
        )}
      </div>
      {busy && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/70 rounded">
          <span className="inline-block w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {dragOver && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[9px] font-medium text-blue-600">Drop image</span>
        </div>
      )}
      {note && !open && (
        <div className="absolute left-0 top-full mt-0.5 z-50 text-[9px] text-gray-600 bg-white border border-gray-200 rounded px-1.5 py-0.5 shadow whitespace-nowrap">
          {note}
        </div>
      )}
      {open && (
        <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl z-50 p-3 w-64">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-700">Section Images</span>
            <div className="flex items-center gap-1 text-[10px]">
              <label className={`px-1.5 py-0.5 rounded cursor-pointer ${position === 'front' ? 'bg-blue-100 text-blue-700' : 'text-gray-400'}`}>
                <input type="radio" name={`pos-${cardId}`} value="front" checked={position === 'front'} onChange={() => setPosition('front')} className="hidden" />
                Front
              </label>
              <label className={`px-1.5 py-0.5 rounded cursor-pointer ${position === 'back' ? 'bg-blue-100 text-blue-700' : 'text-gray-400'}`}>
                <input type="radio" name={`pos-${cardId}`} value="back" checked={position === 'back'} onChange={() => setPosition('back')} className="hidden" />
                Back
              </label>
            </div>
          </div>
          {loading ? (
            <p className="text-xs text-gray-400 text-center py-4">Loading...</p>
          ) : images.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">No images in this section</p>
          ) : (
            <div className="max-h-48 overflow-y-auto space-y-1.5">
              {images.map((img) => (
                <div
                  key={img.id}
                  className={`flex items-center gap-2 p-1.5 rounded border cursor-pointer hover:bg-gray-50 ${
                    img.id === currentImgId ? 'border-blue-400 bg-blue-50' : 'border-gray-100'
                  }`}
                  onClick={() => handleAttach(img.id)}
                >
                  <div className="relative shrink-0">
                    <img src={img.data_uri} alt="" className="w-10 h-10 object-cover rounded" />
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm('Delete this image from the library?')) return;
                        await deleteSectionImage(sectionId, img.id);
                        loadImages();
                        if (img.id === currentImgId) onUpdate();
                      }}
                      className="absolute -bottom-1 -right-1 p-0.5 rounded-full bg-red-100 text-red-500 hover:bg-red-200 hover:text-red-700"
                      title="Delete from library"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-[10px] text-gray-500 truncate block">{img.alt_text_hint || img.category}</span>
                  </div>
                  {img.id === currentImgId && (
                    <span className="text-[9px] text-blue-600 font-medium shrink-0">Current</span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 pt-2 border-t border-gray-100 flex gap-2">
            {currentImgId && (
              <button onClick={handleDetach} className="px-2 py-1 rounded text-[10px] font-medium bg-red-50 text-red-600 hover:bg-red-100">
                Detach
              </button>
            )}
            <button onClick={() => fileRef.current?.click()} className="px-2 py-1 rounded text-[10px] font-medium bg-gray-50 text-gray-600 hover:bg-gray-100">
              Upload
            </button>
            <button onClick={handlePasteButton} className="px-2 py-1 rounded text-[10px] font-medium bg-gray-50 text-gray-600 hover:bg-gray-100" title="Paste image from clipboard">
              Paste
            </button>
            <input ref={fileRef} type="file" accept="image/*" onChange={handleUpload} className="hidden" />
          </div>
          <p className="mt-1.5 text-[9px] text-gray-400 leading-tight">
            Tip: drag an image onto the cell, or press Ctrl+V here, to add it and attach to the front.
          </p>
          {note && (
            <p className="mt-1 text-[9px] text-amber-600">{note}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Optional column definitions ───────────────────────────────────────────────
const OPTIONAL_COLUMNS = [
  { id: 'extra', label: 'Extra / Additional Context' },
  { id: 'ref_img', label: 'Ref Image' },
  { id: 'vignette', label: 'Vignette' },
  { id: 'teaching_case', label: 'Teaching Case' },
] as const;

const DEFAULT_COLUMN_VISIBILITY: VisibilityState = {
  extra: false,
  ref_img: false,
  vignette: false,
  teaching_case: false,
};

// ── Main Component ────────────────────────────────────────────────────────────

export default function CardsPanel({
  sectionId,
  topicPath,
  sectionIds,
  topicTreeId,
  refreshKey,
  refreshUsage,
  onReviewChange,
}: CardsPanelProps) {
  const { selectedModel, selectedRuleSetId, activeTagSet, activeCardVersion } = useSettings();

  // ── Generation controls ──────────────────────────────────────────────────
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [jobRunning, setJobRunning] = useState(false);
  const [jobProgress, setJobProgress] = useState<{ processed: number; total: number } | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [jobAlertError, setJobAlertError] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Card list state ──────────────────────────────────────────────────────
  const [cards, setCards] = useState<Card[]>([]);
  // The single section in scope: an explicit sectionId (Documents path) OR — when
  // reached via a Topic — the lone section all loaded cards share. Lets the
  // single-section actions (Inspect prompt / Add cards) work from both nav paths.
  const effectiveSectionId = useMemo<number | null>(() => {
    if (sectionId != null) return sectionId;
    const ids = new Set(cards.map(c => c.section_id));
    return ids.size === 1 ? (cards[0]?.section_id ?? null) : null;
  }, [sectionId, cards]);
  const [totalCards, setTotalCards] = useState(0);
  const [cardsLoading, setCardsLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: CARDS_PAGE_SIZE });
  // Default to 'active' so rejected (soft-deleted) cards don't linger in the
  // view looking "not deleted". They stay recoverable via the filter dropdown.
  const [statusFilter, setStatusFilter] = useState<'all' | CardStatus>('active');

  // ── Search + display mode ────────────────────────────────────────────────
  const [searchQ, setSearchQ] = useState('');
  const [showAnkiFormat, setShowAnkiFormat] = useState(false);

  // ── Tile view editing ────────────────────────────────────────────────────
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFrontHtml, setEditFrontHtml] = useState('');
  const [editTags, setEditTags] = useState('');

  // ── Per-card regenerate ──────────────────────────────────────────────────
  const [regenLoading, setRegenLoading] = useState(false);
  // Browser-only undo history for regenerations (Card Text + Extra). See regenHistory.ts.
  const [regenHistory, setRegenHistory] = useState<RegenHistory>(() => loadRegenHistory());
  const [historyForCard, setHistoryForCard] = useState<number | null>(null);      // open the version list for this card
  const [rollbackTarget, setRollbackTarget] = useState<{ cardId: number; index: number } | null>(null);  // before/after confirm

  // ── Delete confirmation ──────────────────────────────────────────────────
  const [confirmDeleteCardId, setConfirmDeleteCardId] = useState<number | null>(null);

  // ── Action error ─────────────────────────────────────────────────────────
  const [actionError, setActionError] = useState<string | null>(null);

  // ── View mode ────────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  // Big editor modal: opened from a cell double-click (nav: true) or the row
  // Edit action (nav: false → tabs only, current card).
  const [bigEdit, setBigEdit] = useState<{ cardId: number; field: string; nav: boolean } | null>(null);

  // ── Review marks ─────────────────────────────────────────────────────────
  const [markTypes, setMarkTypes] = useState<ReviewMarkType[]>([]);
  const [markFilterId, setMarkFilterId] = useState<number | null>(null);
  // Inline "new mark" creator inside the Actions menu (avoids a trip to Library).
  const [showNewMark, setShowNewMark] = useState(false);
  const [newMarkName, setNewMarkName] = useState('');
  const [newMarkColor, setNewMarkColor] = useState(MARK_COLORS[0]);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportConfirm, setExportConfirm] = useState<
    { scope: string; section: string; path: string | null; url: string; filename: string } | null
  >(null);
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [validating, setValidating] = useState(false);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [validationRules, setValidationRules] = useState<{ key: string; title: string; criteria: string }[]>([]);
  const [validatorOnly, setValidatorOnly] = useState(false);
  const [validationView, setValidationView] = useState<Card | null>(null);
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const [showMarksMenu, setShowMarksMenu] = useState(false);
  const [showFixBatchModal, setShowFixBatchModal] = useState(false);
  const [fixBatchPrompt, setFixBatchPrompt] = useState('');
  const [fixBatchMarkId, setFixBatchMarkId] = useState<number | null>(null);
  const [fixBatchCardIds, setFixBatchCardIds] = useState<number[]>([]);
  const [fixBatchLoading, setFixBatchLoading] = useState(false);
  const [fixBatchStarted, setFixBatchStarted] = useState(false);

  // ── Section viewer ───────────────────────────────────────────────────────
  const [viewSectionId, setViewSectionId] = useState<number | null>(null);

  // ── Ankify modal ─────────────────────────────────────────────────────────
  const [ankifyOpen, setAnkifyOpen] = useState(false);

  // ── Create presentation modal ─────────────────────────────────────────────
  const [showCreatePresentation, setShowCreatePresentation] = useState(false);

  // ── Generate confirm ─────────────────────────────────────────────────────
  const [showGenerateConfirm, setShowGenerateConfirm] = useState(false);
  const [showSbs, setShowSbs] = useState(false);  // step-by-step generation modal
  // Generation rule sets, so we can show which card version a run will target.
  const [genRuleSets, setGenRuleSets] = useState<RuleSet[]>([]);
  useEffect(() => { getRuleSets('generation').then(setGenRuleSets).catch(() => {}); }, []);
  const targetVersion = genRuleSets.find(r => r.id === selectedRuleSetId)?.card_version ?? 'base';
  const targetVersionLabel = targetVersion === 'base' ? 'Base' : targetVersion.toUpperCase();

  // ── Inspect prompt (debug single section's generation, dry-run) ───────────
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectPrompt, setInspectPrompt] = useState<DebugPromptResult | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [debugModels, setDebugModels] = useState<Model[]>([]);
  const [debugSelected, setDebugSelected] = useState<Set<string>>(new Set());
  const [debugResponses, setDebugResponses] = useState<Record<string, { loading: boolean; result?: DebugRunResult; error?: string }>>({});
  const [activeDebugTab, setActiveDebugTab] = useState<string | null>(null);
  const [debugApply, setDebugApply] = useState<Record<string, { loading: boolean; applied?: number; error?: string }>>({});

  // ── Add manual card(s) ────────────────────────────────────────────────────
  const [showAddCards, setShowAddCards] = useState(false);
  const [addMode, setAddMode] = useState<'single' | 'paste' | 'csv'>('single');
  const [addCsv, setAddCsv] = useState<{ name: string; text: string } | null>(null);
  const [addVersion, setAddVersion] = useState<string>('base');     // which version new cards land in
  const [addIncludeSupp, setAddIncludeSupp] = useState(true);       // import vignette + teaching case
  const [addFront, setAddFront] = useState('');
  const [addExtra, setAddExtra] = useState('');
  const [addTags, setAddTags] = useState('');
  const [addPaste, setAddPaste] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // ── Manual table refresh ──────────────────────────────────────────────────
  const [refreshing, setRefreshing] = useState(false);

  // ── Column sizing ────────────────────────────────────────────────────────
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    try {
      const stored = localStorage.getItem('cards_column_sizing');
      const parsed = stored ? JSON.parse(stored) : {};
      delete parsed['select'];
      return parsed;
    } catch { return {}; }
  });

  // ── Column visibility ────────────────────────────────────────────────────
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
    try {
      const stored = localStorage.getItem('cards_column_visibility');
      return stored ? JSON.parse(stored) : DEFAULT_COLUMN_VISIBILITY;
    } catch { return DEFAULT_COLUMN_VISIBILITY; }
  });

  const [colVisPopover, setColVisPopover] = useState(false);

  // ── Cell selection (DOM refs — no React re-render on select) ─────────────
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const selectedTdRef = useRef<HTMLElement | null>(null);

  // Load mark types on mount
  useEffect(() => {
    getReviewMarkTypes().then(setMarkTypes).catch(() => {});
  }, []);

  // ── Filtered cards ───────────────────────────────────────────────────────
  // Deferred so fast typing doesn't block the input on re-filtering the table
  const deferredSearchQ = useDeferredValue(searchQ);
  const filteredCards = useMemo(() => {
    if (!deferredSearchQ.trim()) return cards;
    const q = deferredSearchQ.toLowerCase();
    return cards.filter(c =>
      (c.front_text ?? stripHtml(c.front_html)).toLowerCase().includes(q) ||
      c.tags.some(t => t.toLowerCase().includes(q)) ||
      (c.tags_mapped ?? []).some(t => t.toLowerCase().includes(q))
    );
  }, [cards, deferredSearchQ]);

  // ── Cell selection handlers ──────────────────────────────────────────────
  const handleCellSelect = useCallback((cellId: string) => {
    if (selectedTdRef.current) {
      selectedTdRef.current.style.boxShadow = '';
      selectedTdRef.current.style.position = '';
    }
    const colonIdx = cellId.indexOf(':');
    const rowIdx = cellId.slice(0, colonIdx);
    const colId = cellId.slice(colonIdx + 1);
    const td = tableContainerRef.current?.querySelector(
      `td[data-row="${rowIdx}"][data-col="${colId}"]`
    ) as HTMLElement | null;
    if (td) {
      td.style.boxShadow = 'inset 0 0 0 2px #3b82f6';
      td.style.position = 'relative';
      selectedTdRef.current = td;
    }
  }, []);

  const handleCellNavigate = useCallback((rowIndex: number, colId: string, dir: 'up' | 'down' | 'left' | 'right') => {
    const navigableCols = ['front_html', 'tags'];
    if (columnVisibility['extra'] !== false) navigableCols.push('extra');
    if (columnVisibility['vignette'] !== false) navigableCols.push('vignette');
    if (columnVisibility['teaching_case'] !== false) navigableCols.push('teaching_case');

    const colIdx = navigableCols.indexOf(colId);
    let newRow = rowIndex;
    let newCol = colId;

    if (dir === 'up') newRow = Math.max(0, rowIndex - 1);
    if (dir === 'down') newRow = Math.min(filteredCards.length - 1, rowIndex + 1);
    if (dir === 'left') newCol = navigableCols[Math.max(0, colIdx - 1)];
    if (dir === 'right') newCol = navigableCols[Math.min(navigableCols.length - 1, colIdx + 1)];

    const target = tableContainerRef.current?.querySelector(
      `[data-cell-id="${newRow}:${newCol}"]`
    ) as HTMLElement | null;
    target?.focus({ preventScroll: false });
    handleCellSelect(`${newRow}:${newCol}`);
  }, [columnVisibility, filteredCards.length, handleCellSelect]);

  // ── Inline cell save handler ─────────────────────────────────────────────
  const handleCellSave = useCallback(async (id: number, params: Parameters<typeof updateCard>[1]) => {
    try {
      await updateCard(id, params);
      // Optimistically update local state (silent refresh)
      setCards(prev => prev.map(c => c.id === id ? { ...c, ...params } as Card : c));
    } catch {
      setActionError('Save failed');
    }
  }, []);

  // ── Fetch cards (server-side pagination) ─────────────────────────────────
  const fetchIdRef = useRef(0);
  const fetchCards = useCallback(
    async (secId: number | null, topic?: string | null, silent?: boolean, page?: number, secIds?: number[] | null) => {
      const fetchId = ++fetchIdRef.current;
      if (!silent) setCardsLoading(true);
      // Fall back to the component's current sectionIds scope so call sites that
      // omit secIds (fetchCards(sectionId, topicPath, true)) don't wipe the table
      // when navigating via a multi-section topic selection.
      if (secId == null && !topic && (!secIds || secIds.length === 0)) {
        secIds = sectionIds ?? null;
      }
      const pageSize = pagination.pageSize;
      const offset = (page ?? pagination.pageIndex) * pageSize;
      const filters = {
        limit: pageSize,
        offset,
        ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
        ...(markFilterId != null ? { mark_type_id: markFilterId } : {}),
        ...(validatorOnly ? { modified_by_validator: true, version: activeCardVersion } : {}),
      };
      try {
        let resp;
        if (secId != null) {
          resp = await getCards({ section_id: secId, ...filters });
        } else if (secIds && secIds.length > 0) {
          resp = await getCards({ section_ids: secIds.join(','), ...filters });
        } else if (topic) {
          resp = await getCards({ topic, ...filters });
        } else {
          if (fetchId === fetchIdRef.current) {
            setCards([]);
            setTotalCards(0);
          }
          if (!silent) setCardsLoading(false);
          return;
        }
        if (fetchId !== fetchIdRef.current) return; // a newer fetch superseded this one
        setCards(resp.cards);
        setTotalCards(resp.total);
        setActionError(null);
        // Page clamp: if the current page ran past the (shrunken) result set,
        // jump back to the last non-empty page. Only ever decreases pageIndex.
        if (offset > 0 && resp.cards.length === 0 && resp.total > 0) {
          const lastPage = Math.max(0, Math.ceil(resp.total / pageSize) - 1);
          setPagination((p) => (p.pageIndex > lastPage ? { ...p, pageIndex: lastPage } : p));
        }
      } catch {
        // surface the failure — an empty table otherwise reads as "no cards"
        setActionError('Failed to load cards — check that the backend is running');
      } finally {
        if (!silent) setCardsLoading(false);
      }
    },
    [pagination.pageSize, pagination.pageIndex, statusFilter, markFilterId, validatorOnly, activeCardVersion, sectionIds]
  );

  // Refetch on dependencies change
  useEffect(() => {
    setPagination((p) => ({ ...p, pageIndex: 0 }));
    setSelectedIds(new Set());
    fetchCards(sectionId, topicPath, false, undefined, sectionIds);
    setSearchQ('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId, topicPath, sectionIds, refreshKey, statusFilter, markFilterId, validatorOnly, activeCardVersion]);

  // Refetch on page change
  useEffect(() => {
    fetchCards(sectionId, topicPath, true, pagination.pageIndex, sectionIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagination.pageIndex]);

  // Self-heal stale views: when the tab/window regains focus, silently refetch
  // so a second user's edits/deletions show up without a manual reload. Skip
  // while an inline edit is in progress so we don't clobber unsaved text.
  useEffect(() => {
    const refresh = () => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      const isEditing =
        editingId != null || tag === 'INPUT' || tag === 'TEXTAREA' || !!el?.isContentEditable;
      if (isEditing) return;
      fetchCards(sectionId, topicPath, true, pagination.pageIndex, sectionIds);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId, topicPath, sectionIds, pagination.pageIndex, editingId, fetchCards]);

  // Persist column sizing
  useEffect(() => {
    localStorage.setItem('cards_column_sizing', JSON.stringify(columnSizing));
  }, [columnSizing]);

  useEffect(() => {
    localStorage.setItem('cards_column_visibility', JSON.stringify(columnVisibility));
  }, [columnVisibility]);

  // ── Table columns ────────────────────────────────────────────────────────

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'select',
        size: 36,
        enableResizing: false,
        header: () => (
          <input
            type="checkbox"
            checked={filteredCards.length > 0 && selectedIds.size === filteredCards.length}
            onChange={() => {
              if (selectedIds.size === filteredCards.length) {
                setSelectedIds(new Set());
              } else {
                setSelectedIds(new Set(filteredCards.map((c) => c.id)));
              }
            }}
            className="w-[18px] h-[18px] cursor-pointer rounded border-gray-300 text-blue-700 focus:ring-blue-500"
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={selectedIds.has(row.original.id)}
            onChange={() => {
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(row.original.id)) next.delete(row.original.id);
                else next.add(row.original.id);
                return next;
              });
            }}
            className="w-[18px] h-[18px] cursor-pointer rounded border-gray-300 text-blue-700 focus:ring-blue-500"
          />
        ),
      }),
      columnHelper.accessor('card_number', {
        header: '#',
        size: 80,
        enableResizing: false,
        cell: (info) => {
          const card = info.row.original;
          const mark = card.review_mark_id != null ? markTypes.find(m => m.id === card.review_mark_id) : undefined;
          return (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    card.status === 'rejected' ? 'bg-red-400' :
                    card.is_reviewed ? 'bg-gray-300' : 'bg-amber-400'
                  }`}
                  title={
                    card.status === 'rejected' ? 'Rejected' :
                    card.is_reviewed ? 'Reviewed' : 'Pending'
                  }
                />
                {(() => {
                  const acc = scoreFor(card, activeCardVersion);
                  if (acc.score == null) return null;
                  return (
                  <span
                    className={`w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white shrink-0 ${
                      acc.score >= 5 ? 'bg-green-500' :
                      acc.score >= 4 ? 'bg-blue-500' :
                      acc.score >= 3 ? 'bg-amber-500' :
                      acc.score >= 2 ? 'bg-red-500' :
                      'bg-red-800'
                    }`}
                    title={`Accuracy${activeCardVersion !== 'base' ? ` (${activeCardVersion.toUpperCase()})` : ''}: ${acc.score}/5${acc.note && acc.note !== 'Accurate' ? ` — ${acc.note}` : ''}${acc.eor ? `\nEOR: ${Object.entries(acc.eor).map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''}`}
                  >
                    {acc.score}
                  </span>
                  );
                })()}
                {(() => {
                  const corr = correctnessFor(card, activeCardVersion);
                  if (!corr.data || corr.score == null) return null;
                  const total = corr.data.total;
                  const fails = total - corr.score;
                  const color = fails === 0 ? 'bg-green-500' : fails === 1 ? 'bg-amber-500' : 'bg-red-600';
                  const lines = corr.data.rules.map(r => `${r.pass ? '✓' : '✗'} ${r.title}${!r.pass && r.reason ? ` — ${r.reason}` : ''}`);
                  const title = `Correctness${activeCardVersion !== 'base' ? ` (${activeCardVersion.toUpperCase()})` : ''}: ${corr.score}/${total}\n${lines.join('\n')}${corr.data.split_suggested ? '\n⚠ Suggest splitting into sibling cards' : ''}`;
                  return (
                    <span
                      className={`min-w-[20px] px-1 py-0.5 flex items-center justify-center text-[8px] font-bold text-white shrink-0 leading-none ${color}`}
                      title={title}
                    >
                      {corr.score}/{total}{corr.data.split_suggested ? ' ⚠' : ''}
                    </span>
                  );
                })()}
                {vcEntryFor(card, activeCardVersion) && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setValidationView(card); }}
                    className="text-[10px] text-violet-600 hover:text-violet-800 shrink-0"
                    title={`${activeCardVersion === 'base' ? 'Base' : activeCardVersion.toUpperCase()} changed by validator (${vcEntryFor(card, activeCardVersion).action}) — click to see before/after`}
                  >
                    ✎
                  </button>
                )}
                <span className={`text-xs tabular-nums ${!card.is_reviewed ? 'font-bold' : 'text-gray-400'}`}>
                  {info.getValue()}
                </span>
              </div>
              {mark && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                  style={{ backgroundColor: mark.color + '22', color: mark.color, border: `1px solid ${mark.color}44` }}
                >
                  {mark.name}
                </span>
              )}
              {card.in_fix_batch && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
                  In batch
                </span>
              )}
              {card.manually_added && (
                <span
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-50 text-violet-700 border border-violet-200"
                  title="Manually added card"
                >
                  MA
                </span>
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor('front_html', {
        header: () => (
          <span>
            Card
            {activeCardVersion !== 'base' && (
              <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-violet-50 text-violet-600 font-semibold uppercase">{activeCardVersion}</span>
            )}
          </span>
        ),
        size: 400,
        cell: (info) => {
          const row = info.row;
          const card = row.original;
          // Each version is independent — show ONLY this version's front (no base fallback).
          const versionedHtml =
            activeCardVersion === 'v1' ? card.front_html_v1 :
            activeCardVersion === 'v2' ? card.front_html_v2 :
            activeCardVersion === 'v3' ? card.front_html_v3 :
            card.front_html;
          const displayHtml = versionedHtml || '';
          const isVersionMissing = activeCardVersion !== 'base' && !versionedHtml;
          const cellId = `${row.index}:front_html`;
          return (
            <EditableCell
              value={displayHtml}
              cellId={cellId}
              onSave={(newVal) => {
                const field = activeCardVersion === 'v1' ? 'front_html_v1' :
                               activeCardVersion === 'v2' ? 'front_html_v2' :
                               activeCardVersion === 'v3' ? 'front_html_v3' : 'front_html';
                handleCellSave(card.id, { [field]: newVal });
              }}
              onSelect={handleCellSelect}
              onNavigate={(dir) => handleCellNavigate(row.index, 'front_html', dir)}
              multiline
              renderDisplay={(v) => {
                const histCount = regenHistory[card.id]?.length ?? 0;
                return (
                  <div className="relative">
                    {histCount > 0 && (
                      <button
                        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setHistoryForCard(card.id); }}
                        title={`${histCount} previous version${histCount > 1 ? 's' : ''} — roll back`}
                        className="absolute top-0 right-0 z-10 flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 hover:bg-amber-200"
                      >
                        <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a4 4 0 110 8H9m-6-8l4-4m-4 4l4 4" />
                        </svg>
                        {histCount}
                      </button>
                    )}
                    {isVersionMissing ? (
                      <span className="text-xs italic text-gray-300">Not generated for {activeCardVersion.toUpperCase()} — click to add</span>
                    ) : (
                      <div
                        className="text-sm leading-relaxed text-gray-800"
                        dangerouslySetInnerHTML={{
                          __html: showAnkiFormat ? renderClozeHtml(v) : v,
                        }}
                      />
                    )}
                  </div>
                );
              }}
            />
          );
        },
      }),
      columnHelper.accessor('tags', {
        header: 'Tags',
        size: 160,
        cell: (info) => {
          const row = info.row;
          const cellId = `${row.index}:tags`;
          const activeTags = activeTagSet === 'old' ? row.original.tags : (row.original.tags_mapped ?? []);
          return (
            <TagsCell
              tags={activeTags}
              cellId={cellId}
              onSave={(newTags) => handleCellSave(row.original.id, activeTagSet === 'old' ? { tags: newTags } : { tags_mapped: newTags })}
              onSelect={handleCellSelect}
              onNavigate={(dir) => handleCellNavigate(row.index, 'tags', dir)}
            />
          );
        },
      }),
      columnHelper.accessor('extra', {
        header: () => (
          <span>
            Extra
            {activeCardVersion !== 'base' && (
              <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-violet-50 text-violet-600 font-semibold uppercase">{activeCardVersion}</span>
            )}
          </span>
        ),
        size: 200,
        cell: (info) => {
          const row = info.row;
          // Versioned extra; empty version column inherits base (matches getFieldValue).
          const val = getFieldValue(row.original, 'extra', activeCardVersion);
          const cellId = `${row.index}:extra`;
          return (
            <EditableCell
              value={val}
              cellId={cellId}
              onSave={(newVal) => handleCellSave(row.original.id, fieldPatch('extra', newVal, activeCardVersion))}
              onSelect={handleCellSelect}
              onNavigate={(dir) => handleCellNavigate(row.index, 'extra', dir)}
              multiline
              renderDisplay={(v) => v
                ? <div className="text-xs text-gray-600" dangerouslySetInnerHTML={{ __html: v }} />
                : <span className="text-gray-300 text-xs">—</span>
              }
            />
          );
        },
      }),
      columnHelper.accessor('ref_img', {
        header: 'Ref Image',
        size: 100,
        cell: (info) => {
          const card = info.row.original;
          return (
            <ImagePickerCell
              cardId={card.id}
              sectionId={card.section_id}
              currentImg={card.ref_img}
              currentImgId={card.ref_img_id}
              currentPosition={card.ref_img_position}
              // silent + pass sectionIds: a plain fetchCards(sectionId, topicPath)
              // wipes the table in topic/multi-section view (sectionId is null), so
              // attaching an image (paste/drop/library) cleared all cards.
              onUpdate={() => fetchCards(sectionId, topicPath, true, undefined, sectionIds)}
            />
          );
        },
      }),
      columnHelper.accessor('vignette', {
        header: 'Vignette',
        size: 200,
        cell: (info) => {
          const row = info.row;
          const val = info.getValue() ?? '';
          const cellId = `${row.index}:vignette`;
          return (
            <EditableCell
              value={val}
              cellId={cellId}
              onSave={(newVal) => handleCellSave(row.original.id, { vignette: newVal || null })}
              onSelect={handleCellSelect}
              onNavigate={(dir) => handleCellNavigate(row.index, 'vignette', dir)}
              multiline
              renderDisplay={(v) => v
                ? <div className="text-xs text-gray-600 line-clamp-3">{v}</div>
                : <span className="text-gray-300 text-xs">—</span>
              }
            />
          );
        },
      }),
      columnHelper.accessor('teaching_case', {
        header: 'Teaching Case',
        size: 200,
        cell: (info) => {
          const row = info.row;
          const val = info.getValue() ?? '';
          const cellId = `${row.index}:teaching_case`;
          return (
            <EditableCell
              value={val}
              cellId={cellId}
              onSave={(newVal) => handleCellSave(row.original.id, { teaching_case: newVal || null })}
              onSelect={handleCellSelect}
              onNavigate={(dir) => handleCellNavigate(row.index, 'teaching_case', dir)}
              multiline
              renderDisplay={(v) => v
                ? <div className="text-xs text-gray-600 line-clamp-3">{v}</div>
                : <span className="text-gray-300 text-xs">—</span>
              }
            />
          );
        },
      }),
      columnHelper.display({
        id: 'row_actions',
        size: 112,
        enableResizing: false,
        header: () => null,
        cell: ({ row }) => {
          const card = row.original;
          const isRejected = card.status === 'rejected';
          return (
            <div className="flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity duration-100">
              <button
                onClick={() => setBigEdit({ cardId: card.id, field: 'front_html', nav: false })}
                className="p-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50"
                title="Edit fields"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                onClick={async () => {
                  if (isRejected) {
                    await updateCard(card.id, { status: 'active' });
                  } else {
                    await rejectCard(card.id);
                  }
                  fetchCards(sectionId, topicPath, true);
                  onReviewChange?.();
                }}
                className={`p-1 rounded ${isRejected ? 'text-gray-400 hover:text-green-600 hover:bg-green-50' : 'text-gray-400 hover:text-red-600 hover:bg-red-50'}`}
                title={isRejected ? 'Restore' : 'Reject'}
              >
                {isRejected ? (
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                ) : (
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => setConfirmDeleteCardId(card.id)}
                className="p-1 rounded text-gray-400 hover:text-red-700 hover:bg-red-50"
                title="Delete"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
              <button
                onClick={() => setViewSectionId(card.section_id)}
                className="p-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50"
                title="View source section"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </button>
            </div>
          );
        },
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredCards.length, selectedIds, handleCellSelect, handleCellNavigate, handleCellSave, showAnkiFormat, sectionId, sectionIds, topicPath, onReviewChange, fetchCards, markTypes, activeTagSet, activeCardVersion, regenHistory]
  );

  const pageCount = Math.ceil(totalCards / pagination.pageSize);

  const table = useReactTable({
    data: filteredCards,
    columns,
    state: { pagination, columnSizing, columnVisibility },
    onPaginationChange: setPagination,
    onColumnSizingChange: setColumnSizing,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount,
    columnResizeMode: 'onChange',
  });

  // ── Generation flow ──────────────────────────────────────────────────────

  const handleEstimate = useCallback(async () => {
    if (!selectedRuleSetId || !selectedModel) return;
    setEstimating(true);
    setEstimate(null);
    try {
      const params: { rule_set_id: number; model: string; section_ids?: number[]; topic_path?: string; topic_tree_id?: number } = {
        rule_set_id: selectedRuleSetId,
        model: selectedModel,
      };
      if (sectionId) params.section_ids = [sectionId];
      else if (sectionIds && sectionIds.length > 0) params.section_ids = sectionIds;
      else if (topicPath) params.topic_path = topicPath;
      else if (topicTreeId) params.topic_tree_id = topicTreeId;
      const est = await estimateCost(params);
      setEstimate(est);
    } catch {
      setJobError('Estimate failed');
    } finally {
      setEstimating(false);
    }
  }, [selectedRuleSetId, selectedModel, sectionId, sectionIds, topicPath, topicTreeId]);

  const handleGenerate = useCallback(async () => {
    if (!selectedRuleSetId || !selectedModel) return;
    setShowGenerateConfirm(false);
    setJobRunning(true);
    setJobProgress(null);
    setJobError(null);
    try {
      const params: { rule_set_id: number; model: string; section_ids?: number[]; topic_path?: string; topic_tree_id?: number; replace_existing?: boolean } = {
        rule_set_id: selectedRuleSetId,
        model: selectedModel,
      };
      if (sectionId) params.section_ids = [sectionId];
      else if (sectionIds && sectionIds.length > 0) params.section_ids = sectionIds;
      else if (topicPath) params.topic_path = topicPath;
      else if (topicTreeId) params.topic_tree_id = topicTreeId;
      const { job_id } = await startGeneration(params);
      setActiveJobId(job_id);

      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(async () => {
        try {
          const job = await getGenerationJob(job_id);
          setJobProgress({ processed: job.processed_sections, total: job.total_sections });
          if (job.status === 'done' || job.status === 'failed') {
            if (intervalRef.current) clearInterval(intervalRef.current);
            setJobRunning(false);
            if (job.status === 'failed') {
              setJobAlertError(job.error_message ?? 'Generation failed');
            } else if (job.error_message) {
              // done with partial failures (some sections/scoring failed)
              setJobAlertError(`Finished with warnings: ${job.error_message}`);
            }
            fetchCards(sectionId, topicPath, false, undefined, sectionIds);
            onReviewChange?.();
            refreshUsage?.();
          }
        } catch {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setJobRunning(false);
        }
      }, 1500);
    } catch (err: unknown) {
      setJobRunning(false);
      setJobError(err instanceof Error ? err.message : 'Start failed');
    }
  }, [selectedRuleSetId, selectedModel, sectionId, sectionIds, topicTreeId, topicPath, fetchCards, onReviewChange, refreshUsage]);

  // Step 1: instantly pull the exact prompt (no API call, no cost).
  const handleInspectPrompt = useCallback(async () => {
    if (!effectiveSectionId) return;
    setInspectLoading(true);
    setInspectError(null);
    setInspectPrompt(null);
    setDebugResponses({});
    setActiveDebugTab(null);
    setDebugApply({});
    try {
      const res = await debugPromptSection(effectiveSectionId, { rule_set_id: selectedRuleSetId ?? undefined });
      setInspectPrompt(res);
      // Default-select the current model; load the model list if needed.
      setDebugSelected(new Set(selectedModel ? [selectedModel] : []));
      if (debugModels.length === 0) {
        getModels().then(setDebugModels).catch(() => {});
      }
    } catch (err: unknown) {
      setInspectError(err instanceof Error ? err.message : 'Inspect failed');
    } finally {
      setInspectLoading(false);
    }
  }, [effectiveSectionId, selectedRuleSetId, selectedModel, debugModels.length]);

  // Step 2: run the prompt against each selected model in parallel (dry-run).
  const handleGenerateResponses = useCallback(async () => {
    if (!effectiveSectionId || debugSelected.size === 0) return;
    const models = Array.from(debugSelected);
    setDebugResponses(prev => {
      const next = { ...prev };
      models.forEach(m => { next[m] = { loading: true }; });
      return next;
    });
    setActiveDebugTab(prev => (prev && models.includes(prev)) ? prev : models[0]);
    await Promise.all(models.map(async (m) => {
      try {
        const result = await debugRunSection(effectiveSectionId, { model: m, rule_set_id: selectedRuleSetId ?? undefined });
        setDebugResponses(prev => ({ ...prev, [m]: { loading: false, result } }));
      } catch (err: unknown) {
        setDebugResponses(prev => ({ ...prev, [m]: { loading: false, error: err instanceof Error ? err.message : 'Run failed' } }));
      }
    }));
    refreshUsage?.();
  }, [effectiveSectionId, debugSelected, selectedRuleSetId, refreshUsage]);

  // Apply a model's debug response as real cards. The response is already in our
  // number|card|extra format, so we parse it with the real card parser (no Haiku).
  const handleApplyDebug = useCallback(async (modelId: string) => {
    if (!effectiveSectionId) return;
    const resp = debugResponses[modelId]?.result;
    if (!resp || !resp.raw_response.trim()) return;
    setDebugApply(prev => ({ ...prev, [modelId]: { loading: true } }));
    try {
      const { created } = await addManualCards({
        section_id: effectiveSectionId,
        raw_text: resp.raw_response,
        format: 'pipe',
        model: modelId,
      });
      setDebugApply(prev => ({ ...prev, [modelId]: { loading: false, applied: created.length } }));
      await fetchCards(sectionId, topicPath, true, undefined, sectionIds);
      onReviewChange?.();
    } catch (err: unknown) {
      setDebugApply(prev => ({ ...prev, [modelId]: { loading: false, error: err instanceof Error ? err.message : 'Apply failed' } }));
    }
  }, [effectiveSectionId, debugResponses, fetchCards, sectionId, topicPath, sectionIds, onReviewChange]);

  // Manual refresh of the card list (so a second user's edits show without a full reload).
  const handleManualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchCards(sectionId, topicPath, true, pagination.pageIndex, sectionIds);
    } finally {
      setRefreshing(false);
    }
  }, [fetchCards, sectionId, topicPath, pagination.pageIndex, sectionIds]);

  // Add manually-written or pasted card(s) to the current single section.
  const handleAddManualCards = useCallback(async () => {
    if (!effectiveSectionId) return;
    setAddLoading(true);
    setAddError(null);
    try {
      const payload: Parameters<typeof addManualCards>[0] = {
        section_id: effectiveSectionId,
        model: selectedModel,
        card_version: addVersion,
        include_supplementals: addIncludeSupp,
      };
      if (addMode === 'single') {
        if (!addFront.trim()) { setAddError('Card front is required'); setAddLoading(false); return; }
        payload.cards = [{
          front_html: addFront.trim(),
          extra: addExtra.trim() || null,
          tags: splitTags(addTags),
        }];
      } else if (addMode === 'csv') {
        if (!addCsv?.text.trim()) { setAddError('Choose a CSV file first'); setAddLoading(false); return; }
        payload.csv_text = addCsv.text;
      } else {
        if (!addPaste.trim()) { setAddError('Paste some card text first'); setAddLoading(false); return; }
        payload.raw_text = addPaste.trim();
      }
      const { created } = await addManualCards(payload);
      if (!created.length) { setAddError('No cards were created from that input'); setAddLoading(false); return; }
      setShowAddCards(false);
      setAddFront(''); setAddExtra(''); setAddTags(''); setAddPaste(''); setAddCsv(null);
      await fetchCards(sectionId, topicPath, true, undefined, sectionIds);
      onReviewChange?.();
      refreshUsage?.();
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : 'Add failed');
    } finally {
      setAddLoading(false);
    }
  }, [effectiveSectionId, sectionId, selectedModel, addMode, addFront, addExtra, addTags, addPaste, addCsv, addVersion, addIncludeSupp, fetchCards, topicPath, sectionIds, onReviewChange, refreshUsage]);

  // Resume polling for active jobs on mount and when topic/section context changes (handles page refresh)
  useEffect(() => {
    if (jobRunning) return;
    getActiveJobs().then((jobs) => {
      const relevant = jobs.find(j =>
        (sectionId && j.section_id === sectionId) ||
        (topicTreeId && j.topic_tree_id === topicTreeId)
      );
      if (!relevant) return;
      setJobRunning(true);
      setActiveJobId(relevant.id);
      setJobProgress({ processed: relevant.processed_sections, total: relevant.total_sections });
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(async () => {
        try {
          const job = await getGenerationJob(relevant.id);
          setJobProgress({ processed: job.processed_sections, total: job.total_sections });
          if (job.status === 'done' || job.status === 'failed') {
            if (intervalRef.current) clearInterval(intervalRef.current);
            setJobRunning(false);
            if (job.status === 'failed') {
              setJobAlertError(job.error_message ?? 'Generation failed');
            } else if (job.error_message) {
              setJobAlertError(`Finished with warnings: ${job.error_message}`);
            }
            fetchCards(sectionId, topicPath, false, undefined, sectionIds);
            onReviewChange?.();
            refreshUsage?.();
          }
        } catch {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setJobRunning(false);
        }
      }, 1500);
    }).catch(() => {});
  }, [sectionId, topicTreeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // ── Card actions ─────────────────────────────────────────────────────────

  const handleEdit = useCallback((card: Card) => {
    setEditingId(card.id);
    setEditFrontHtml(card.front_html);
    const tagsForEdit = activeTagSet === 'old' ? card.tags : (card.tags_mapped ?? []);
    setEditTags(joinTags(tagsForEdit));
  }, [activeTagSet]);

  const handleSaveEdit = useCallback(async (id: number) => {
    try {
      const tags = splitTags(editTags);
      const tagUpdate = activeTagSet === 'old' ? { tags } : { tags_mapped: tags };
      await updateCard(id, { front_html: editFrontHtml, ...tagUpdate });
      setEditingId(null);
      fetchCards(sectionId, topicPath, true);
    } catch {
      setActionError('Save failed');
    }
  }, [activeTagSet, editFrontHtml, editTags, fetchCards, sectionId, topicPath]);

  const handleReject = useCallback(async (id: number) => {
    try {
      await rejectCard(id);
      fetchCards(sectionId, topicPath, true);
      onReviewChange?.();
    } catch {
      setActionError('Reject failed');
    }
  }, [fetchCards, sectionId, topicPath, onReviewChange]);

  const handleRestore = useCallback(async (id: number) => {
    try {
      await updateCard(id, { status: 'active' });
      fetchCards(sectionId, topicPath, true);
      onReviewChange?.();
    } catch {
      setActionError('Restore failed');
    }
  }, [fetchCards, sectionId, topicPath, onReviewChange]);

  const handleDeleteCard = useCallback(async () => {
    if (confirmDeleteCardId == null) return;
    try {
      await deleteCard(confirmDeleteCardId);
      setConfirmDeleteCardId(null);
      fetchCards(sectionId, topicPath, true);
      onReviewChange?.();
    } catch {
      setActionError('Delete failed');
    }
  }, [confirmDeleteCardId, fetchCards, sectionId, topicPath, onReviewChange]);

  const handleRegen = useCallback(async (id: number, prompt: string) => {
    setRegenLoading(true);
    try {
      const prev = cards.find(c => c.id === id);
      if (prev) setRegenHistory(h => pushSnapshots(h, [{ id, front_html: prev.front_html, extra: prev.extra }], Date.now()));
      await regenerateCard(id, { model: selectedModel, prompt: prompt || undefined, card_version: activeCardVersion });
      fetchCards(sectionId, topicPath, true);
      refreshUsage?.();
    } catch {
      setActionError('Regeneration failed');
    } finally {
      setRegenLoading(false);
    }
  }, [cards, selectedModel, fetchCards, sectionId, topicPath, refreshUsage]);

  // Apply a snapshot back onto the card (Card Text + Extra) and prune it + newer.
  const handleRollback = useCallback(async (cardId: number, index: number) => {
    const snap = regenHistory[cardId]?.[index];
    if (!snap) return;
    try {
      await updateCard(cardId, { front_html: snap.front_html, extra: snap.extra });
      setCards(prev => prev.map(c => c.id === cardId ? { ...c, front_html: snap.front_html, extra: snap.extra } as Card : c));
      const { history } = rollbackToIndex(regenHistory, cardId, index);
      setRegenHistory(history);
      setRollbackTarget(null);
      setHistoryForCard(null);
    } catch {
      setActionError('Rollback failed');
    }
  }, [regenHistory]);

  const [showBulkRegenModal, setShowBulkRegenModal] = useState(false);
  const [bulkRegenPrompt, setBulkRegenPrompt] = useState('');
  // Regenerate-modal mode: recreate (1:1, today) | split (1→N) | combine (N→1, Phase B).
  const [regenMode, setRegenMode] = useState<'recreate' | 'split' | 'combine'>('recreate');
  const [splitKeepOriginal, setSplitKeepOriginal] = useState(false);  // default: delete (reject) original
  const [splitLoading, setSplitLoading] = useState(false);
  const [splitBatchId, setSplitBatchId] = useState<number | null>(null);
  const [splitProposal, setSplitProposal] = useState<FixProposal | null>(null);  // in-place review modal when set
  // Editable copy of the split's proposed new cards (front/extra), persisted on accept.
  const [splitCards, setSplitCards] = useState<Array<{ front_html: string; extra: string | null; tags: string[] }>>([]);
  const splitPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (splitPollRef.current) clearInterval(splitPollRef.current); }, []);
  useEffect(() => { if (showBulkRegenModal) setRegenMode('recreate'); }, [showBulkRegenModal]);

  // Kick off a split as an unmarked, in-place fix batch on the single selected card.
  const handleSplitStart = useCallback(async () => {
    if (selectedIds.size !== 1) return;
    const cardId = [...selectedIds][0];
    const guidance = bulkRegenPrompt.trim() || 'Use your judgment to divide the content sensibly.';
    const prompt =
      'Split this single flashcard into 2 or more separate, focused cloze cards. ' +
      'Use action "split" and return the resulting cards in new_cards (each with its own front_html, extra, and tags). ' +
      "Distribute the original card's additional context (extra) appropriately across the new cards. " +
      'These cards come from one card and are closely related, so give each new card an "extra" that includes the connecting context — ' +
      'briefly reference the related concept(s) covered by the sibling card(s) so each card still stands on its own and the link between them is preserved. ' +
      'Guidance: ' +
      guidance;
    setSplitLoading(true);
    try {
      const { batch_id } = await createFixBatch({ card_ids: [cardId], prompt, model: selectedModel });
      setSplitBatchId(batch_id);
      splitPollRef.current = setInterval(async () => {
        try {
          const batch = await getFixBatch(batch_id);
          if (batch.status === 'done') {
            clearInterval(splitPollRef.current!); splitPollRef.current = null;
            setSplitLoading(false);
            const prop = batch.proposals?.[0] ?? null;
            setShowBulkRegenModal(false);
            if (prop) { setSplitProposal(prop); setSplitCards(prop.new_cards_json ?? []); }
            else setActionError('Split produced no proposal');
          } else if (batch.status === 'cancelled') {
            // A restart sweep or explicit cancel can kill the batch — stop polling
            // instead of spinning forever.
            clearInterval(splitPollRef.current!); splitPollRef.current = null;
            setSplitLoading(false);
            setActionError('Split cancelled');
          }
        } catch {
          clearInterval(splitPollRef.current!); splitPollRef.current = null;
          setSplitLoading(false); setActionError('Split failed');
        }
      }, 1500);
    } catch {
      setSplitLoading(false); setActionError('Split failed');
    }
  }, [selectedIds, bulkRegenPrompt, selectedModel]);

  const handleSplitConfirm = useCallback(async () => {
    if (splitBatchId == null) return;
    const originalId = splitProposal?.original_card_id;
    try {
      // Persist any edits to the proposed new cards before applying.
      if (splitProposal) {
        await updateFixProposalContent(splitBatchId, splitProposal.id, { new_cards_json: splitCards });
      }
      // Confirm with keep_original=true so it only creates the new cards; if the
      // user chose "delete", hard-delete the original so it actually disappears
      // (a soft reject would still show under the default "All statuses" view).
      await confirmFixBatch(splitBatchId, undefined, true);
      if (!splitKeepOriginal && originalId != null) {
        await bulkDeleteCards({ card_ids: [originalId] });
      }
      setSplitProposal(null);
      setSplitBatchId(null);
      setBulkRegenPrompt('');
      setSelectedIds(new Set());
      fetchCards(sectionId, topicPath, true, undefined, sectionIds);
      onReviewChange?.();
    } catch {
      setActionError('Could not apply split');
    }
  }, [splitBatchId, splitProposal, splitCards, splitKeepOriginal, fetchCards, sectionId, topicPath, sectionIds, onReviewChange]);

  const handleSplitCancel = useCallback(async () => {
    const id = splitBatchId;
    setSplitProposal(null);
    setSplitCards([]);
    setSplitBatchId(null);
    if (id != null) { try { await cancelFixBatch(id); } catch { /* best-effort */ } }
  }, [splitBatchId]);

  // ── Single-card Recreate via preview→review→accept (like split) ──────────
  const [regenProposal, setRegenProposal] = useState<{ cardId: number; front_html: string; extra: string | null } | null>(null);
  const [regenPreviewLoading, setRegenPreviewLoading] = useState(false);
  const [regenRetryPrompt, setRegenRetryPrompt] = useState('');

  const handleRegenPreview = useCallback(async (cardId: number, prompt: string) => {
    setRegenPreviewLoading(true);
    try {
      const res = await regenerateCardPreview(cardId, { model: selectedModel, prompt: prompt || undefined, card_version: activeCardVersion });
      setRegenProposal({ cardId, front_html: res.front_html, extra: res.extra ?? null });
      setShowBulkRegenModal(false);
    } catch {
      setActionError('Regenerate failed');
    } finally {
      setRegenPreviewLoading(false);
    }
  }, [selectedModel, activeCardVersion]);

  const handleRegenAccept = useCallback(async () => {
    if (!regenProposal) return;
    const cur = cards.find(c => c.id === regenProposal.cardId);
    try {
      // Snapshot the current card for rollback only now, at accept time.
      if (cur) setRegenHistory(h => pushSnapshots(h, [{ id: cur.id, front_html: cur.front_html, extra: cur.extra }], Date.now()));
      await updateCard(regenProposal.cardId, {
        ...fieldPatch('front_html', regenProposal.front_html, activeCardVersion),
        ...fieldPatch('extra', regenProposal.extra ?? '', activeCardVersion),
      });
      setRegenProposal(null);
      setBulkRegenPrompt('');
      setSelectedIds(new Set());
      fetchCards(sectionId, topicPath, true, undefined, sectionIds);
      onReviewChange?.();
    } catch {
      setActionError('Could not apply the regenerated card');
    }
  }, [regenProposal, cards, fetchCards, sectionId, topicPath, sectionIds, onReviewChange, activeCardVersion]);

  // ── Combine (N→1) ────────────────────────────────────────────────────────
  const [combineLoading, setCombineLoading] = useState(false);
  const [combineProposal, setCombineProposal] = useState<CombineProposal | null>(null);  // in-place review when set

  const handleCombineStart = useCallback(async () => {
    if (selectedIds.size < 2) return;
    setCombineLoading(true);
    try {
      const proposal = await combinePreview({ card_ids: [...selectedIds], prompt: bulkRegenPrompt.trim() || undefined, model: selectedModel });
      setShowBulkRegenModal(false);
      setCombineProposal(proposal);
    } catch {
      setActionError('Combine failed');
    } finally {
      setCombineLoading(false);
    }
  }, [selectedIds, bulkRegenPrompt, selectedModel]);

  const handleCombineConfirm = useCallback(async () => {
    if (!combineProposal) return;
    try {
      await combineApply({
        card_ids: combineProposal.source_card_ids,
        front_html: combineProposal.front_html,
        extra: combineProposal.extra,
        tags: combineProposal.tags,
        keep_original: splitKeepOriginal,
        model: selectedModel,
      });
      setCombineProposal(null);
      setBulkRegenPrompt('');
      setSelectedIds(new Set());
      fetchCards(sectionId, topicPath, true, undefined, sectionIds);
      onReviewChange?.();
    } catch {
      setActionError('Could not apply combine');
    }
  }, [combineProposal, splitKeepOriginal, selectedModel, fetchCards, sectionId, topicPath, sectionIds, onReviewChange]);

  const [bulkRegenProgress, setBulkRegenProgress] = useState<{ done: number; total: number } | null>(null);

  const [bulkRegenScope, setBulkRegenScope] = useState<'selected' | 'all'>('selected');

  const handleBulkRegen = useCallback(async (prompt: string, scope: 'selected' | 'all') => {
    let ids: number[];
    if (scope === 'all') {
      // Fetch all card IDs for the current context
      try {
        const allParams: Parameters<typeof getCards>[0] = { limit: 10000, offset: 0, status: 'active' };
        if (sectionId) allParams.section_id = sectionId;
        else if (sectionIds && sectionIds.length > 0) allParams.section_ids = sectionIds.join(',');
        const resp = await getCards(allParams);
        ids = resp.cards.map(c => c.id);
        // snapshot from the freshly-fetched full card objects
        setRegenHistory(h => pushSnapshots(h, resp.cards.map(c => ({ id: c.id, front_html: c.front_html, extra: c.extra })), Date.now()));
      } catch {
        setActionError('Failed to fetch all cards');
        return;
      }
    } else {
      ids = [...selectedIds];
      // snapshot the selected cards' current Card Text + Extra before they're overwritten
      const snaps = cards.filter(c => selectedIds.has(c.id)).map(c => ({ id: c.id, front_html: c.front_html, extra: c.extra }));
      if (snaps.length) setRegenHistory(h => pushSnapshots(h, snaps, Date.now()));
    }
    if (ids.length === 0) return;
    setBulkRegenProgress({ done: 0, total: ids.length });
    try {
      for (let i = 0; i < ids.length; i++) {
        await regenerateCard(ids[i], { model: selectedModel, prompt: prompt || undefined, card_version: activeCardVersion });
        setBulkRegenProgress({ done: i + 1, total: ids.length });
      }
      setShowBulkRegenModal(false);
      setBulkRegenPrompt('');
      setBulkRegenProgress(null);
      setSelectedIds(new Set());
      fetchCards(sectionId, topicPath, true, undefined, sectionIds);
      refreshUsage?.();
      onReviewChange?.();
    } catch {
      setActionError('Bulk regeneration failed');
      setBulkRegenProgress(null);
    }
  }, [cards, selectedIds, selectedModel, sectionId, sectionIds, fetchCards, topicPath, refreshUsage, onReviewChange]);

  // ── Bulk actions ─────────────────────────────────────────────────────────

  const handleBulkReview = useCallback(async (markAs: boolean) => {
    if (selectedIds.size === 0) return;
    try {
      await bulkMarkReviewed([...selectedIds], markAs);
      setSelectedIds(new Set());
      fetchCards(sectionId, topicPath, true);
      onReviewChange?.();
    } catch {
      setActionError('Bulk review failed');
    }
  }, [selectedIds, fetchCards, sectionId, topicPath, onReviewChange]);

  const handleBulkDelete = useCallback(async (scope: 'selected' | 'all') => {
    if (scope === 'selected' && selectedIds.size === 0) return;
    try {
      if (scope === 'all') {
        if (sectionId) {
          await bulkDeleteCards({ section_id: sectionId });
        } else if (sectionIds && sectionIds.length > 0) {
          await bulkDeleteCards({ section_ids: sectionIds });
        } else if (topicTreeId) {
          await bulkDeleteCards({ topic_tree_id: topicTreeId });
        }
      } else {
        await bulkDeleteCards({ card_ids: [...selectedIds] });
      }
      setSelectedIds(new Set());
      fetchCards(sectionId, topicPath, true, undefined, sectionIds);
      onReviewChange?.();
    } catch {
      setActionError('Bulk delete failed');
    }
  }, [selectedIds, fetchCards, sectionId, sectionIds, topicTreeId, topicPath, onReviewChange]);

  const handleCreateMark = useCallback(async () => {
    const name = newMarkName.trim();
    if (!name) return;
    try {
      await createReviewMarkType({ name, color: newMarkColor, sort_order: markTypes.length });
      const fresh = await getReviewMarkTypes();
      setMarkTypes(fresh);
      setNewMarkName('');
      setNewMarkColor(MARK_COLORS[0]);
      setShowNewMark(false);
      // Menu stays open so the new mark is right there to click and apply.
    } catch {
      setActionError('Could not create mark');
    }
  }, [newMarkName, newMarkColor, markTypes.length]);

  const handleBulkMark = useCallback(async (markTypeId: number | null) => {
    if (selectedIds.size === 0) return;
    const cardIds = [...selectedIds];
    try {
      await bulkMarkCards({ card_ids: cardIds, mark_type_id: markTypeId });
      setShowActionsMenu(false);
      fetchCards(sectionId, topicPath, true);
      onReviewChange?.();
      // If marking with a real type, immediately open the fix batch modal
      if (markTypeId !== null) {
        setFixBatchCardIds(cardIds);
        setFixBatchMarkId(markTypeId);
        setFixBatchPrompt('');
        setFixBatchStarted(false);
        setShowFixBatchModal(true);
      }
      setSelectedIds(new Set());
    } catch {
      setActionError('Mark failed');
    }
  }, [selectedIds, fetchCards, sectionId, topicPath, onReviewChange]);

  const handleCreateFixBatch = useCallback(async () => {
    if (fixBatchCardIds.length === 0 || !fixBatchMarkId || !fixBatchPrompt.trim()) return;
    setFixBatchLoading(true);
    try {
      await createFixBatch({
        mark_type_id: fixBatchMarkId,
        card_ids: fixBatchCardIds,
        prompt: fixBatchPrompt.trim(),
        model: selectedModel,
      });
      setFixBatchStarted(true);
      fetchCards(sectionId, topicPath, true);
    } catch {
      setActionError('Failed to create fix batch');
    } finally {
      setFixBatchLoading(false);
    }
  }, [fixBatchCardIds, fixBatchMarkId, fixBatchPrompt, selectedModel, fetchCards, sectionId, topicPath]);

  const handleGenSupplemental = useCallback(async (scope: 'selected' | 'all') => {
    if (!selectedRuleSetId || !selectedModel) return;
    try {
      const params: Parameters<typeof startSupplemental>[0] = {
        rule_set_id: selectedRuleSetId,
        model: selectedModel,
        replace_existing: true,
      };
      if (scope === 'all') {
        if (sectionId) params.section_id = sectionId;
        else if (sectionIds && sectionIds.length > 0) params.section_ids = sectionIds;
        else { params.card_ids = [...selectedIds]; }
      } else {
        params.card_ids = [...selectedIds];
      }
      const { job_id } = await startSupplemental(params);
      setJobRunning(true);
      setJobProgress(null);
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(async () => {
        try {
          const job = await getGenerationJob(job_id);
          setJobProgress({ processed: job.processed_sections, total: job.total_sections });
          if (job.status === 'done' || job.status === 'failed') {
            if (intervalRef.current) clearInterval(intervalRef.current);
            setJobRunning(false);
            if (job.status === 'failed') {
              setJobAlertError(job.error_message ?? 'Supplemental generation failed');
            } else if (job.error_message) {
              setJobAlertError(`Finished with warnings: ${job.error_message}`);
            }
            fetchCards(sectionId, topicPath, true, undefined, sectionIds);
            refreshUsage?.();
          }
        } catch {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setJobRunning(false);
        }
      }, 1500);
    } catch {
      setActionError('Failed to start vignette & case generation');
    }
  }, [selectedIds, selectedRuleSetId, selectedModel, fetchCards, sectionId, sectionIds, topicPath, refreshUsage]);

  // Resolve the card IDs to act on for a given scope. 'selected' → the checked
  // rows; 'all' → every card in the current section/topic.
  const idsForScope = useCallback(async (scope: 'selected' | 'all'): Promise<number[]> => {
    if (scope === 'selected') return [...selectedIds];
    const allCards = await getCards({
      ...(sectionId ? { section_id: sectionId } : {}),
      ...(sectionIds && sectionIds.length > 0 ? { section_ids: sectionIds.join(',') } : {}),
      ...(!sectionId && !sectionIds?.length && topicPath ? { topic: topicPath } : {}),
      limit: 10000, offset: 0, status: 'active',
    });
    return allCards.cards.map(c => c.id);
  }, [selectedIds, sectionId, sectionIds, topicPath]);

  const doScore = useCallback(async (scope: 'selected' | 'all') => {
    setShowActionsMenu(false);
    setScoring(true);
    try {
      const ids = await idsForScope(scope);
      if (ids.length === 0) return;
      await bulkScoreCards({ card_ids: ids, model: selectedModel, card_version: activeCardVersion });
      fetchCards(sectionId, topicPath, true, undefined, sectionIds);
    } catch { setActionError('Scoring failed'); } finally { setScoring(false); }
  }, [idsForScope, selectedModel, activeCardVersion, fetchCards, sectionId, topicPath, sectionIds]);

  const doValidate = useCallback(async (scope: 'selected' | 'all') => {
    setShowActionsMenu(false);
    setValidating(true);
    try {
      const ids = await idsForScope(scope);
      if (ids.length === 0) return;
      await validateCards({ card_ids: ids, model: selectedModel, auto_fix: true, card_version: activeCardVersion });
      fetchCards(sectionId, topicPath, true, undefined, sectionIds);
    } catch { setActionError('Validation failed'); } finally { setValidating(false); }
  }, [idsForScope, selectedModel, activeCardVersion, fetchCards, sectionId, topicPath, sectionIds]);

  const doRegen = useCallback((scope: 'selected' | 'all') => {
    setShowActionsMenu(false);
    setBulkRegenScope(scope);
    setShowBulkRegenModal(true);
  }, []);

  // ── Empty state ──────────────────────────────────────────────────────────

  const hasContext = sectionId != null || topicPath != null || (sectionIds != null && sectionIds.length > 0);
  // "All in topic" actions need a concrete section/section-set to operate over.
  const hasTopicScope = !!(sectionId || (sectionIds && sectionIds.length > 0));

  if (!hasContext) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-sm text-gray-400">Select a section or topic from the sidebar</p>
        </div>
      </div>
    );
  }

  // ── Export URL ────────────────────────────────────────────────────────────
  // Section name + topic path for export labels/filenames. Prefer the topicPath
  // prop (Topics nav); fall back to the loaded cards, which carry section_heading
  // + curriculum_topic_path (Documents nav, where topicPath is empty).
  const scopeCard = cards[0];
  const scopeSectionName =
    scopeCard?.section_heading
    || (topicPath ? topicPath.split(' > ').pop() : null)
    || 'this section';
  const scopePath = topicPath || scopeCard?.curriculum_topic_path || null;
  // Filename: "Section_Name|Full > Topic > Path.csv". Section gets underscores;
  // the path keeps its " > " spacing. Strip only chars illegal in filenames
  // (/ : \) — keep | > spaces % en-dash.
  const sanitizeFilePart = (s: string) => s.replace(/[/:\\]/g, '-').replace(/[\x00-\x1f]/g, '').trim();
  const scopeSectionPart = sanitizeFilePart(scopeSectionName).replace(/\s+/g, '_') || 'cards';
  const scopePathPart = scopePath ? sanitizeFilePart(scopePath) : null;
  const scopeFileName = scopePathPart ? `${scopeSectionPart}|${scopePathPart}.csv` : `${scopeSectionPart}.csv`;

  // "All in scope" export: prefer the single section (so the file is named after
  // it), then the topic path, then the whole tree.
  // Only trust effectiveSectionId when a real sectionId prop is set — in topic
  // view it is derived from the current page's cards and would page-dependently
  // narrow the export to one section.
  const allScopeUrl = sectionId != null
    ? exportCardsUrl({ section_id: sectionId, tag_set: activeTagSet, card_version: activeCardVersion })
    : topicPath
      ? exportCardsUrl({ topic_path: topicPath, tag_set: activeTagSet, card_version: activeCardVersion })
      : topicTreeId
        ? exportCardsUrl({ topic_tree_id: topicTreeId, tag_set: activeTagSet, card_version: activeCardVersion })
        : undefined;

  // Download via a blob so the exact client-side filename is used — the plain
  // `download` attribute is ignored when the server sends its own
  // Content-Disposition, but a blob: URL always honors it.
  const triggerDownload = async (url: string, filename: string) => {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
    } catch {
      window.location.href = url;  // fallback: let the server name it
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-2 flex-wrap">
        {/* View toggle */}
        <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
          <button
            onClick={() => setViewMode('table')}
            className={`px-2.5 py-1 text-xs font-medium transition-colors duration-150 ${viewMode === 'table' ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'}`}
          >
            Table
          </button>
          <button
            onClick={() => setViewMode('cards')}
            className={`px-2.5 py-1 text-xs font-medium transition-colors duration-150 ${viewMode === 'cards' ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'}`}
          >
            Cards
          </button>
        </div>

        {/* Refresh cards from DB (no full page reload) */}
        <button
          onClick={handleManualRefresh}
          disabled={refreshing || cardsLoading}
          className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors duration-150"
          title="Refresh cards from the database"
        >
          <span className={`inline-block ${refreshing ? 'animate-spin' : ''}`} aria-hidden>↻</span>
        </button>

        {/* Validator-changed filter */}
        <button
          onClick={() => setValidatorOnly(v => !v)}
          className={`text-xs rounded-lg px-2 py-1.5 border transition-colors duration-150 ${validatorOnly ? 'bg-violet-100 text-violet-700 border-violet-300' : 'text-gray-600 border-gray-200 hover:bg-gray-50'}`}
          title="Show only cards the validator changed (fixed or split) — review just the deltas"
        >
          ✎ Changed
        </button>

        {/* Status filter */}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | CardStatus)}
          className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="rejected">Rejected</option>
        </select>

        {/* Mark type filter */}
        {markTypes.length > 0 && (
          <div className="relative">
            <select
              value={markFilterId ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setMarkFilterId(v === '' ? null : Number(v));
                setPagination(p => ({ ...p, pageIndex: 0 }));
              }}
              className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 pr-6"
            >
              <option value="">All marks</option>
              {markTypes.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Global search */}
        <div className="relative">
          <svg className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search cards…"
            className="w-44 text-xs border border-gray-200 rounded-lg pl-7 pr-6 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {searchQ && (
            <button onClick={() => setSearchQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Column visibility (table mode) */}
        {viewMode === 'table' && (
          <div className="relative">
            <button
              onClick={() => setColVisPopover((v) => !v)}
              className="px-2 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
            >
              Columns
            </button>
            {colVisPopover && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setColVisPopover(false)} />
                <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-xl p-2 min-w-[180px]">
                  {OPTIONAL_COLUMNS.map((col) => (
                    <label key={col.id} className="flex items-center gap-2 px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50 rounded cursor-pointer">
                      <input
                        type="checkbox"
                        checked={columnVisibility[col.id] !== false}
                        onChange={() => setColumnVisibility((prev) => ({ ...prev, [col.id]: !prev[col.id] }))}
                        className="rounded border-gray-300 text-blue-700 focus:ring-blue-500"
                      />
                      {col.label}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Anki / Text toggle (table mode) */}
        {viewMode === 'table' && (
          <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden" title="Toggle cloze rendering">
            <button
              onClick={() => setShowAnkiFormat(false)}
              className={`px-2 py-1 text-xs font-medium transition-colors duration-150 ${!showAnkiFormat ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              Text
            </button>
            <button
              onClick={() => setShowAnkiFormat(true)}
              className={`px-2 py-1 text-xs font-medium transition-colors duration-150 ${showAnkiFormat ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              Anki
            </button>
          </div>
        )}

        <div className="flex-1" />

        {/* Search result count vs total */}
        <span className="text-xs text-gray-400 tabular-nums">
          {searchQ.trim() ? `${filteredCards.length} / ${totalCards}` : totalCards} cards
        </span>

      </div>

      {/* Selection action bar — only shown when cards are selected */}
      {selectedIds.size > 0 && (
        <div className="shrink-0 bg-blue-50 border-b border-blue-200 px-4 py-1.5 flex items-center gap-2">
          <span className="text-xs text-blue-700 font-semibold">{selectedIds.size} selected</span>
          <div className="w-px h-4 bg-blue-200" />

          {/* Mark Reviewed / Unmark */}
          {(() => {
            const selectedCards = cards.filter(c => selectedIds.has(c.id));
            const allReviewed = selectedCards.length > 0 && selectedCards.every(c => c.is_reviewed);
            return (
              <button
                onClick={() => handleBulkReview(!allReviewed)}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors duration-150 ${allReviewed ? 'text-amber-700 bg-amber-50 border-amber-200 hover:bg-amber-100' : 'text-green-700 bg-green-50 border-green-200 hover:bg-green-100'}`}
              >
                {allReviewed ? 'Unmark Reviewed' : 'Mark Reviewed'}
              </button>
            );
          })()}

          {/* Actions dropdown — groups less common actions */}
          <div className="relative">
            <button
              onClick={() => setShowActionsMenu(v => !v)}
              className="px-2.5 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
            >
              Actions ▾
            </button>
            {showActionsMenu && (
              <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 w-[340px] py-1">
                <button onClick={() => { setShowActionsMenu(false); setAnkifyOpen(true); }} className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                  Ankify
                </button>
                <button onClick={() => { setShowActionsMenu(false); setShowCreatePresentation(true); }} className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                  Save Presentation
                </button>
                <div className="border-t border-gray-100 my-1" />
                {/* AI actions — left column acts on the selected rows, right column on everything in the section/topic */}
                <div className="px-2 pb-1">
                  <div className="grid grid-cols-2 gap-x-1.5 gap-y-1">
                    <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-wide text-center">Selected ({selectedIds.size})</div>
                    <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-wide text-center">
                      {/* Label reflects the actual scope idsForScope uses. */}
                      All in {sectionId ? 'section' : sectionIds && sectionIds.length > 0 ? 'group' : 'topic'} ({totalCards})
                    </div>

                    <button disabled={selectedIds.size === 0} onClick={() => doRegen('selected')} className="px-2 py-1 text-[11px] font-medium text-amber-700 bg-amber-50 rounded hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed">Regenerate</button>
                    <button disabled={!hasTopicScope} onClick={() => doRegen('all')} className="px-2 py-1 text-[11px] font-medium text-amber-700 bg-amber-50 rounded hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed">Regenerate</button>

                    <button disabled={selectedIds.size === 0 || jobRunning || !selectedRuleSetId} onClick={() => { setShowActionsMenu(false); handleGenSupplemental('selected'); }} className="px-2 py-1 text-[11px] font-medium text-indigo-700 bg-indigo-50 rounded hover:bg-indigo-100 disabled:opacity-40 disabled:cursor-not-allowed">Vignettes &amp; Cases</button>
                    <button disabled={!hasTopicScope || jobRunning || !selectedRuleSetId} onClick={() => { setShowActionsMenu(false); handleGenSupplemental('all'); }} className="px-2 py-1 text-[11px] font-medium text-indigo-700 bg-indigo-50 rounded hover:bg-indigo-100 disabled:opacity-40 disabled:cursor-not-allowed">Vignettes &amp; Cases</button>

                    <button disabled={selectedIds.size === 0 || scoring} onClick={() => doScore('selected')} className="px-2 py-1 text-[11px] font-medium text-teal-700 bg-teal-50 rounded hover:bg-teal-100 disabled:opacity-40 disabled:cursor-not-allowed">Score Cards</button>
                    <button disabled={!hasTopicScope || scoring} onClick={() => doScore('all')} className="px-2 py-1 text-[11px] font-medium text-teal-700 bg-teal-50 rounded hover:bg-teal-100 disabled:opacity-40 disabled:cursor-not-allowed">Score Cards</button>

                    <button disabled={selectedIds.size === 0 || validating} onClick={() => doValidate('selected')} className="px-2 py-1 text-[11px] font-medium text-violet-700 bg-violet-50 rounded hover:bg-violet-100 disabled:opacity-40 disabled:cursor-not-allowed">Validate &amp; fix</button>
                    <button disabled={!hasTopicScope || validating} onClick={() => doValidate('all')} className="px-2 py-1 text-[11px] font-medium text-violet-700 bg-violet-50 rounded hover:bg-violet-100 disabled:opacity-40 disabled:cursor-not-allowed">Validate &amp; fix</button>
                  </div>
                  <button
                    onClick={async () => {
                      setShowActionsMenu(false);
                      try {
                        if (validationRules.length === 0) setValidationRules(await getValidationRules());
                        setShowRulesModal(true);
                      } catch { setActionError('Could not load rules'); }
                    }}
                    className="mt-1.5 w-full text-center px-2 py-1 text-[10px] text-gray-500 hover:bg-gray-50 rounded"
                  >
                    ⓘ What does Validate &amp; fix check?
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Marking actions dropdown — bulk-mark rows, manage marks, AI fix batch */}
          <div className="relative">
            <button
              onClick={() => setShowMarksMenu(v => !v)}
              className="px-2.5 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
            >
              Marks ▾
            </button>
            {showMarksMenu && (
              <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 min-w-[200px] py-1">
                <p className="px-3 py-1 text-[9px] font-semibold text-gray-400 uppercase tracking-wide">Mark selected as ({selectedIds.size})</p>
                {markTypes.map(m => (
                  <button key={m.id} onClick={() => { setShowMarksMenu(false); handleBulkMark(m.id); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 text-left">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
                    {m.name}
                  </button>
                ))}
                {markTypes.length > 0 && (
                  <button onClick={() => { setShowMarksMenu(false); handleBulkMark(null); }} className="w-full px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 text-left">
                    Clear mark
                  </button>
                )}
                {/* Inline "new mark" creator — no round-trip to Library > Marks */}
                {showNewMark ? (
                  <div className="px-3 py-2 flex flex-col gap-1.5" onMouseDown={(e) => e.stopPropagation()}>
                    <input
                      autoFocus
                      value={newMarkName}
                      onChange={(e) => setNewMarkName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); handleCreateMark(); }
                        if (e.key === 'Escape') { setShowNewMark(false); setNewMarkName(''); }
                      }}
                      placeholder="New mark name…"
                      className="w-full text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <div className="flex items-center gap-1">
                      {MARK_COLORS.map((col) => (
                        <button
                          key={col}
                          onClick={() => setNewMarkColor(col)}
                          className={`w-4 h-4 rounded-full ${newMarkColor === col ? 'ring-2 ring-offset-1 ring-gray-400' : ''}`}
                          style={{ backgroundColor: col }}
                          title={col}
                        />
                      ))}
                    </div>
                    <div className="flex items-center gap-2 pt-0.5">
                      <button onClick={handleCreateMark} disabled={!newMarkName.trim()} className="px-2 py-0.5 text-[11px] font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50">Create</button>
                      <button onClick={() => { setShowNewMark(false); setNewMarkName(''); }} className="px-2 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100 rounded">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setShowNewMark(true)} className="w-full text-left px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-50">+ New mark…</button>
                )}
                {markTypes.length > 0 && (
                  <>
                    <div className="border-t border-gray-100 my-1" />
                    <button
                      onClick={() => { setShowMarksMenu(false); setFixBatchMarkId(markFilterId ?? (markTypes[0]?.id ?? null)); setFixBatchPrompt(''); setShowFixBatchModal(true); }}
                      className="w-full text-left px-3 py-1.5 text-xs text-purple-700 hover:bg-purple-50"
                    >
                      AI Fix Batch
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Export CSV dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowExportMenu(v => !v)}
              className="px-2.5 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
            >
              Export ▾
            </button>
            {showExportMenu && (
              <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 min-w-[190px] py-1">
                {selectedIds.size > 0 && (
                  <button
                    className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                    onClick={() => {
                      setShowExportMenu(false);
                      setExportConfirm({
                        scope: `Selected cards (${selectedIds.size})`,
                        section: scopeSectionName,
                        path: scopePath,
                        url: exportCardsUrl({ card_ids: [...selectedIds], tag_set: activeTagSet, card_version: activeCardVersion }),
                        filename: scopeFileName,
                      });
                    }}
                  >
                    Selected only ({selectedIds.size})
                  </button>
                )}
                {allScopeUrl && (
                  <button
                    className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                    onClick={() => {
                      setShowExportMenu(false);
                      setExportConfirm({
                        scope: effectiveSectionId != null ? 'All cards in this section' : 'All cards in this topic',
                        section: scopeSectionName,
                        path: scopePath,
                        url: allScopeUrl,
                        filename: scopeFileName,
                      });
                    }}
                  >
                    {effectiveSectionId != null ? 'All cards in this section' : 'All cards in this topic'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Delete */}
          <div className="relative">
            {selectedIds.size === filteredCards.length && totalCards > selectedIds.size ? (
              <>
                <button
                  onClick={() => setShowDeleteMenu(v => !v)}
                  className="px-2.5 py-1 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors duration-150"
                >
                  Delete ▾
                </button>
                {showDeleteMenu && (
                  <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 min-w-[190px] py-1">
                    <button
                      onClick={() => { setShowDeleteMenu(false); handleBulkDelete('selected'); }}
                      className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                    >
                      Selected only ({selectedIds.size})
                    </button>
                    <button
                      onClick={() => { setShowDeleteMenu(false); handleBulkDelete('all'); }}
                      className="block w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                    >
                      All cards in topic ({totalCards})
                    </button>
                  </div>
                )}
              </>
            ) : (
              <button
                onClick={() => handleBulkDelete('selected')}
                className="px-2.5 py-1 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors duration-150"
              >
                Delete
              </button>
            )}
          </div>
          {/* Activity spinner */}
          {(jobRunning || bulkRegenProgress || scoring || validating) && (
            <div className="flex items-center gap-1.5 ml-2 text-[10px] text-blue-600">
              <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span>{bulkRegenProgress ? `Regen ${bulkRegenProgress.done}/${bulkRegenProgress.total}` : validating ? 'Validating...' : scoring ? 'Scoring...' : 'Generating...'}</span>
            </div>
          )}
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto p-1 text-blue-400 hover:text-blue-700 rounded"
            title="Clear selection"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Topic-level presentation button — shown whenever a topic is selected */}
      {topicTreeId != null && selectedIds.size === 0 && (
        <div className="shrink-0 bg-gray-50 border-b border-gray-200 px-4 py-1.5 flex items-center gap-2">
          <span className="text-[10px] text-gray-400">Topic</span>
          <button
            onClick={() => setShowCreatePresentation(true)}
            className="px-2.5 py-1 text-xs font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 transition-colors duration-150"
            title="Create a shareable Ankify presentation for all cards in this topic"
          >
            Create Presentation
          </button>
        </div>
      )}

      {/* Generation controls */}
      {hasContext && (
        <div className="shrink-0 bg-gray-50 border-b border-gray-200 px-4 py-2 flex items-center gap-2">
          <button
            onClick={handleEstimate}
            disabled={estimating || jobRunning || !selectedRuleSetId}
            className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors duration-150"
          >
            {estimating ? 'Estimating...' : 'Estimate Cost'}
          </button>
          {estimate && (
            <span className="text-xs text-gray-500">
              ~${estimate.estimated_cost_usd.toFixed(3)} ({estimate.estimated_input_tokens.toLocaleString()} in / {estimate.estimated_output_tokens.toLocaleString()} out)
            </span>
          )}
          <button
            onClick={() => setShowGenerateConfirm(true)}
            disabled={jobRunning || !selectedRuleSetId}
            className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors duration-150"
          >
            {jobRunning
              ? `Generating… ${jobProgress ? `${jobProgress.processed}/${jobProgress.total}` : ''}`
              : 'Generate Cards'}
          </button>
          {effectiveSectionId && (
            <button
              onClick={() => setShowSbs(true)}
              disabled={jobRunning}
              className="px-2 py-1.5 text-xs font-medium text-indigo-700 bg-white border border-indigo-200 rounded-lg hover:bg-indigo-50 disabled:opacity-50 transition-colors duration-150"
              title="Phased step-by-step generation (segment → author → assemble) with a downloadable audit"
            >
              Generate — Step by Step
            </button>
          )}
          {effectiveSectionId && (
            <button
              onClick={handleInspectPrompt}
              disabled={inspectLoading || jobRunning}
              className="px-2 py-1.5 text-xs font-medium text-blue-700 bg-white border border-blue-200 rounded-lg hover:bg-blue-50 disabled:opacity-50 transition-colors duration-150 flex items-center gap-1"
              title="Inspect the exact prompt we send to Claude + the raw response (dry-run, nothing saved)"
            >
              {inspectLoading ? 'Inspecting…' : (<><span aria-hidden>🔍</span> Inspect prompt</>)}
            </button>
          )}
          {effectiveSectionId && (
            <button
              onClick={() => { setShowAddCards(true); setAddError(null); setAddVersion(activeCardVersion); }}
              disabled={jobRunning}
              className="px-2 py-1.5 text-xs font-medium text-violet-700 bg-white border border-violet-200 rounded-lg hover:bg-violet-50 disabled:opacity-50 transition-colors duration-150"
              title="Add a card by hand, or paste cards from a Claude-chat session"
            >
              + Add card(s)
            </button>
          )}
          {inspectError && <span className="text-xs text-red-600">{inspectError}</span>}
          {jobRunning && activeJobId && (
            <button
              onClick={async () => {
                try {
                  await cancelGenerationJob(activeJobId);
                  if (intervalRef.current) clearInterval(intervalRef.current);
                  setJobRunning(false);
                  setActiveJobId(null);
                  setJobError('Cancelled');
                } catch { /* ignore */ }
              }}
              className="px-2 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors duration-150"
              title="Cancel generation"
            >
              ✕ Stop
            </button>
          )}
          {jobError && <span className="text-xs text-red-600">{jobError}</span>}
        </div>
      )}

      {/* Card content */}
      <div className="flex-1 overflow-auto">
        {cardsLoading ? (
          <div className="flex items-center justify-center h-32">
            <span className="text-xs text-gray-400">Loading cards…</span>
          </div>
        ) : cards.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <span className="text-xs text-gray-400">No cards yet. Generate some!</span>
          </div>
        ) : viewMode === 'cards' ? (
          // Card grid view
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredCards.map((card, idx) => (
              <CardTile
                key={card.id}
                card={card}
                cardIndex={pagination.pageIndex * pagination.pageSize + idx + 1}
                onEdit={handleEdit}
                onReject={handleReject}
                onRestore={handleRestore}
                onDelete={(id) => setConfirmDeleteCardId(id)}
                editingId={editingId}
                editFrontHtml={editFrontHtml}
                setEditFrontHtml={setEditFrontHtml}
                editTags={editTags}
                setEditTags={setEditTags}
                onSave={handleSaveEdit}
                onCancel={() => setEditingId(null)}
                regenLoading={regenLoading}
                onRegen={handleRegen}
                selected={selectedIds.has(card.id)}
                onToggleSelect={(id) => {
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                }}
                onViewSection={setViewSectionId}
              />
            ))}
          </div>
        ) : (
          // Table view — Excel-like grid
          <div ref={tableContainerRef} className="overflow-auto h-full">
            <table className="w-full text-left border-collapse">
              <thead className="bg-gray-50 sticky top-0 z-10">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wide border border-gray-200 relative bg-gray-50"
                        style={{ width: header.getSize() }}
                      >
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getCanResize() && (
                          <div
                            onMouseDown={header.getResizeHandler()}
                            onTouchStart={header.getResizeHandler()}
                            className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-400 transition-colors"
                          />
                        )}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-b border-gray-100 group/row transition-colors duration-100 ${
                      selectedIds.has(row.original.id) ? 'bg-blue-50/40' : 'hover:bg-gray-50/60'
                    }`}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        data-row={row.index}
                        data-col={cell.column.id}
                        className="border border-gray-100 align-top"
                        style={{
                          width: cell.column.getSize(),
                          // ref_img: zero padding + relative so the picker can fill the
                          // whole cell via absolute inset-0 (drop zone + image sizing).
                          padding: cell.column.id === 'ref_img'
                            ? 0
                            : ['select', 'card_number', 'status', 'row_actions'].includes(cell.column.id) ? '6px 8px' : '6px 10px',
                          position: cell.column.id === 'ref_img' ? 'relative' : undefined,
                        }}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="shrink-0 bg-white border-t border-gray-200 px-4 py-2 flex items-center justify-between">
          <button
            onClick={() => setPagination((p) => ({ ...p, pageIndex: Math.max(0, p.pageIndex - 1) }))}
            disabled={pagination.pageIndex === 0}
            className="px-2.5 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors duration-150"
          >
            Previous
          </button>
          <span className="text-xs text-gray-500 tabular-nums">
            Page {pagination.pageIndex + 1} of {pageCount}
          </span>
          <button
            onClick={() => setPagination((p) => ({ ...p, pageIndex: Math.min(pageCount - 1, p.pageIndex + 1) }))}
            disabled={pagination.pageIndex >= pageCount - 1}
            className="px-2.5 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors duration-150"
          >
            Next
          </button>
        </div>
      )}

      {/* Modals */}
      {confirmDeleteCardId != null && (
        <ConfirmModal
          title="Delete Card"
          message="Are you sure you want to permanently delete this card?"
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDeleteCard}
          onCancel={() => setConfirmDeleteCardId(null)}
        />
      )}

      {jobAlertError && (
        <AlertModal
          title="Generation Failed"
          message={jobAlertError}
          onClose={() => setJobAlertError(null)}
        />
      )}

      {actionError && (
        <AlertModal
          title="Error"
          message={actionError}
          onClose={() => setActionError(null)}
        />
      )}

      {showGenerateConfirm && (
        <ConfirmModal
          title="Generate Cards"
          message={`Generate cards using ${selectedModel}, into version: ${targetVersionLabel}${targetVersion !== 'base' ? ' (fills that version on existing base cards)' : ''}.${estimate ? ` Estimated cost: $${estimate.estimated_cost_usd.toFixed(3)}.` : ''}`}
          confirmLabel="Generate"
          onConfirm={handleGenerate}
          onCancel={() => setShowGenerateConfirm(false)}
        />
      )}

      {showSbs && effectiveSectionId && (
        <SbsGenerateModal
          sectionId={effectiveSectionId}
          model={selectedModel}
          onClose={() => setShowSbs(false)}
          onDone={() => fetchCards(sectionId, topicPath, false, undefined, sectionIds)}
        />
      )}

      {ankifyOpen && (
        <AnkifyModal
          cards={selectedIds.size > 0 ? cards.filter(c => selectedIds.has(c.id)) : filteredCards}
          onClose={() => setAnkifyOpen(false)}
        />
      )}

      {/* Inspect prompt (instant) → run response(s) per model on demand */}
      {inspectPrompt && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setInspectPrompt(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl border border-gray-200 w-[920px] max-w-[95vw] max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
              <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">
                Prompt &amp; response · {inspectPrompt.section_heading}
              </h2>
              <button onClick={() => setInspectPrompt(null)} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-4">
              <div>
                <div className="text-[11px] font-semibold text-gray-500 uppercase mb-1">System + User Rules Prompt</div>
                <pre className="text-[11px] whitespace-pre-wrap break-words bg-gray-50 border border-gray-200 rounded-lg p-2 max-h-48 overflow-auto font-mono">{inspectPrompt.system}</pre>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-gray-500 uppercase mb-1">Section content</div>
                <pre className="text-[11px] whitespace-pre-wrap break-words bg-gray-50 border border-gray-200 rounded-lg p-2 max-h-48 overflow-auto font-mono">{inspectPrompt.user}</pre>
              </div>

              {/* Model picker + run */}
              <div className="border-t border-gray-200 pt-3">
                <div className="text-[11px] font-semibold text-gray-500 uppercase mb-2">Run response on these models</div>
                <div className="flex flex-wrap items-center gap-3 mb-2">
                  {debugModels.map((m) => (
                    <label key={m.id} className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={debugSelected.has(m.id)}
                        onChange={(e) => setDebugSelected(prev => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(m.id); else next.delete(m.id);
                          return next;
                        })}
                      />
                      {m.display}
                    </label>
                  ))}
                  {debugModels.length === 0 && <span className="text-[11px] text-gray-400">Loading models…</span>}
                </div>
                <button
                  onClick={handleGenerateResponses}
                  disabled={debugSelected.size === 0 || Object.values(debugResponses).some(r => r.loading)}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50"
                >
                  {Object.values(debugResponses).some(r => r.loading) ? 'Running…' : `Generate response${debugSelected.size > 1 ? 's' : ''} (${debugSelected.size})`}
                </button>
              </div>

              {/* Per-model responses — tabbed so you can switch and compare.
                  All panes stay mounted (hidden via display) so each tab keeps
                  its own scroll position when you come back to it. */}
              {debugModels.some(dm => debugResponses[dm.id]) && (
                <div>
                  <div className="flex flex-wrap gap-1 border-b border-gray-200 mb-2">
                    {debugModels.filter(dm => debugResponses[dm.id]).map((dm) => {
                      const r = debugResponses[dm.id];
                      const isActive = activeDebugTab === dm.id;
                      return (
                        <button
                          key={dm.id}
                          onClick={() => setActiveDebugTab(dm.id)}
                          className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border-b-2 -mb-px flex items-center gap-1.5 ${
                            isActive ? 'border-blue-600 text-blue-700 bg-blue-50' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          {dm.display}
                          {r.loading && <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
                          {r.error && <span className="text-red-500">!</span>}
                        </button>
                      );
                    })}
                  </div>
                  {debugModels.filter(dm => debugResponses[dm.id]).map((dm) => {
                    const r = debugResponses[dm.id];
                    const isActive = activeDebugTab === dm.id;
                    return (
                      <div key={dm.id} style={{ display: isActive ? 'block' : 'none' }}>
                        <div className="flex items-center justify-end gap-2 mb-1">
                          {r.result && (
                            <span className="text-[11px] text-gray-500">
                              {r.result.usage.input_tokens.toLocaleString()} in / {r.result.usage.output_tokens.toLocaleString()} out · ${r.result.cost_usd.toFixed(4)}
                              {r.result.stop_reason === 'max_tokens' && <span className="text-red-600"> · TRUNCATED</span>}
                            </span>
                          )}
                          {r.result && (
                            <button
                              onClick={() => navigator.clipboard.writeText(r.result!.raw_response)}
                              className="px-2 py-0.5 text-[11px] font-medium text-blue-700 border border-blue-200 rounded hover:bg-blue-50"
                            >
                              Copy
                            </button>
                          )}
                          {r.result && (
                            <button
                              onClick={() => handleApplyDebug(dm.id)}
                              disabled={debugApply[dm.id]?.loading}
                              className="px-2 py-0.5 text-[11px] font-medium text-white bg-violet-700 rounded hover:bg-violet-800 disabled:opacity-50"
                              title="Create these cards in the section (parsed from this response)"
                            >
                              {debugApply[dm.id]?.loading ? 'Applying…' : 'Apply cards'}
                            </button>
                          )}
                          {debugApply[dm.id]?.applied != null && (
                            <span className="text-[11px] text-green-600">✓ {debugApply[dm.id]!.applied} added</span>
                          )}
                          {debugApply[dm.id]?.error && (
                            <span className="text-[11px] text-red-600">{debugApply[dm.id]!.error}</span>
                          )}
                        </div>
                        {r.loading ? (
                          <div className="text-[11px] text-gray-400 bg-gray-50 border border-gray-200 rounded-lg p-2">Running…</div>
                        ) : r.error ? (
                          <div className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{r.error}</div>
                        ) : (
                          <pre className="text-[11px] whitespace-pre-wrap break-words bg-blue-50 border border-blue-200 rounded-lg p-2 max-h-[65vh] overflow-auto font-mono resize-y">{r.result?.raw_response}</pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-gray-200">
              <button
                onClick={() => navigator.clipboard.writeText(`SYSTEM:\n${inspectPrompt.system}\n\nUSER:\n${inspectPrompt.user}`)}
                className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Copy prompt
              </button>
              <button
                onClick={() => setInspectPrompt(null)}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add manual / pasted card(s) */}
      {showAddCards && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => !addLoading && setShowAddCards(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl border border-gray-200 w-[640px] max-w-[94vw] max-h-[88vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
              <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">Add card(s) to this section</h2>
              <div className="flex gap-1">
                <button
                  onClick={() => setAddMode('single')}
                  className={`px-2 py-1 text-[11px] font-medium rounded-lg ${addMode === 'single' ? 'bg-violet-100 text-violet-700' : 'text-gray-500 hover:bg-gray-100'}`}
                >
                  Single card
                </button>
                <button
                  onClick={() => setAddMode('paste')}
                  className={`px-2 py-1 text-[11px] font-medium rounded-lg ${addMode === 'paste' ? 'bg-violet-100 text-violet-700' : 'text-gray-500 hover:bg-gray-100'}`}
                >
                  Paste from chat
                </button>
                <button
                  onClick={() => setAddMode('csv')}
                  className={`px-2 py-1 text-[11px] font-medium rounded-lg ${addMode === 'csv' ? 'bg-violet-100 text-violet-700' : 'text-gray-500 hover:bg-gray-100'}`}
                >
                  Import CSV
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-3">
              {addMode === 'single' ? (
                <>
                  <div>
                    <label className="text-[11px] font-semibold text-gray-500 uppercase">Card front (use {'{{c1::term}}'} for clozes)</label>
                    <textarea value={addFront} onChange={(e) => setAddFront(e.target.value)} rows={4}
                      className="w-full mt-1 text-xs border border-gray-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-violet-500" />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-gray-500 uppercase">Extra (optional)</label>
                    <textarea value={addExtra} onChange={(e) => setAddExtra(e.target.value)} rows={3}
                      className="w-full mt-1 text-xs border border-gray-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-violet-500" />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-gray-500 uppercase">Tags (:: -separated, optional — defaults to section tags)</label>
                    <input value={addTags} onChange={(e) => setAddTags(e.target.value)} placeholder="tag1::tag2"
                      className="w-full mt-1 text-xs border border-gray-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-violet-500" />
                  </div>
                </>
              ) : addMode === 'csv' ? (
                <div>
                  <label className="text-[11px] font-semibold text-gray-500 uppercase">Import from an exported cards CSV</label>
                  <p className="text-[11px] text-gray-500 mt-0.5">Select a CSV exported from this app. Cards are added to this section <b>exactly as written</b> (no AI rewording). Rows missing a card front are skipped.</p>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) { setAddCsv(null); return; }
                      const text = await file.text();
                      setAddCsv({ name: file.name, text });
                      setAddError(null);
                    }}
                    className="w-full mt-2 text-xs text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-violet-100 file:text-violet-700 file:text-xs file:font-medium hover:file:bg-violet-200"
                  />
                  {addCsv && (
                    <p className="text-[11px] text-emerald-700 mt-2">
                      Loaded <b>{addCsv.name}</b> — {addCsv.text.split('\n').filter(l => l.trim()).length - 1} row(s) detected.
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <label className="text-[11px] font-semibold text-gray-500 uppercase">Paste card(s) — any format</label>
                  <p className="text-[11px] text-gray-500 mt-0.5">Haiku will split this into cards and route the text into fields verbatim (it won't reword anything). One or many cards.</p>
                  <textarea value={addPaste} onChange={(e) => setAddPaste(e.target.value)} rows={10}
                    className="w-full mt-1 text-xs border border-gray-200 rounded-lg p-2 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500" />
                </div>
              )}

              {/* Shared: which version the new fronts/extra land in + whether to
                  import the (unversioned, shared) vignette + teaching case. */}
              <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-gray-100">
                <label className="flex items-center gap-1.5 text-[11px] font-medium text-gray-600">
                  Add to version:
                  <select
                    value={addVersion}
                    onChange={(e) => setAddVersion(e.target.value)}
                    className="text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-violet-500"
                  >
                    <option value="base">Base</option>
                    <option value="v1">V1</option>
                    <option value="v2">V2</option>
                    <option value="v3">V3</option>
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-[11px] font-medium text-gray-600">
                  <input
                    type="checkbox"
                    checked={addIncludeSupp}
                    onChange={(e) => setAddIncludeSupp(e.target.checked)}
                    className="rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                  />
                  Import vignette + teaching case
                </label>
              </div>
              {addVersion !== 'base' && (
                <p className="text-[11px] text-amber-600">
                  Heads up: these cards go into <b>{addVersion.toUpperCase()}</b> only — their base front stays empty, so they show as version-only cards.
                </p>
              )}
              {addError && <div className="text-xs text-red-600">{addError}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-gray-200">
              <button onClick={() => setShowAddCards(false)} disabled={addLoading}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-lg disabled:opacity-50">
                Cancel
              </button>
              <button onClick={handleAddManualCards} disabled={addLoading}
                className="px-3 py-1.5 text-xs font-medium text-white bg-violet-700 rounded-lg hover:bg-violet-800 disabled:opacity-50">
                {addLoading
                  ? (addMode === 'paste' ? 'Parsing…' : addMode === 'csv' ? 'Importing…' : 'Adding…')
                  : (addMode === 'csv' ? 'Import cards' : 'Add card(s)')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export confirmation — verify scope before the file downloads. */}
      {exportConfirm && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setExportConfirm(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl border border-gray-200 w-[460px] max-w-[92vw] flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
              <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">Confirm export</h2>
              <button onClick={() => setExportConfirm(null)} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
            </div>
            <div className="p-4 space-y-2 text-xs text-gray-700">
              <div><span className="text-gray-400 uppercase text-[10px] font-semibold">Exporting</span><br />{exportConfirm.scope}</div>
              <div><span className="text-gray-400 uppercase text-[10px] font-semibold">Section</span><br /><b>{exportConfirm.section}</b></div>
              <div><span className="text-gray-400 uppercase text-[10px] font-semibold">Topic path</span><br />{exportConfirm.path ?? '—'}</div>
              <div><span className="text-gray-400 uppercase text-[10px] font-semibold">File name</span><br /><span className="font-mono text-[11px]">{exportConfirm.filename}</span></div>
              <p className="text-[11px] text-gray-400 pt-1">Check this looks right, then download.</p>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-gray-200">
              <button onClick={() => setExportConfirm(null)}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
              <button
                onClick={() => { triggerDownload(exportConfirm.url, exportConfirm.filename); setExportConfirm(null); }}
                className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700">
                Download CSV
              </button>
            </div>
          </div>
        </div>
      )}

      {bigEdit && (
        <BigEditModal
          cards={filteredCards}
          cardId={bigEdit.cardId}
          field={bigEdit.field}
          activeCardVersion={activeCardVersion}
          activeTagSet={activeTagSet}
          enableCardNav={bigEdit.nav}
          onSave={handleCellSave}
          onClose={() => setBigEdit(null)}
        />
      )}

      {/* Regeneration history — list of saved previous versions for one card */}
      {historyForCard != null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/30" onClick={() => setHistoryForCard(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl border border-gray-200 w-[440px] max-h-[70vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
              <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">Regeneration history</h2>
              <button onClick={() => setHistoryForCard(null)} className="p-1 text-gray-400 hover:text-gray-600 rounded">✕</button>
            </div>
            <div className="overflow-auto p-2">
              {(regenHistory[historyForCard] ?? []).length === 0 ? (
                <p className="text-xs text-gray-400 px-2 py-3">No saved versions.</p>
              ) : (
                [...(regenHistory[historyForCard] ?? []).keys()].reverse().map((idx) => {
                  const s = regenHistory[historyForCard]![idx];
                  return (
                    <button
                      key={idx}
                      onClick={() => setRollbackTarget({ cardId: historyForCard, index: idx })}
                      className="w-full text-left px-2 py-2 rounded hover:bg-amber-50 border-b border-gray-50 last:border-0"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-gray-700">Version {idx + 1}</span>
                        <span className="text-[10px] text-gray-400">{new Date(s.ts).toLocaleString()}</span>
                      </div>
                      <div className="text-[11px] text-gray-500 line-clamp-2 mt-0.5" dangerouslySetInnerHTML={{ __html: s.front_html }} />
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Before/after confirm before a rollback actually applies */}
      {rollbackTarget && (() => {
        const cur = cards.find(c => c.id === rollbackTarget.cardId) ?? filteredCards.find(c => c.id === rollbackTarget.cardId);
        const snap = regenHistory[rollbackTarget.cardId]?.[rollbackTarget.index];
        if (!cur || !snap) return null;
        return (
          <div className="fixed inset-0 z-[70] flex items-center justify-center" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-black/40" onClick={() => setRollbackTarget(null)} />
            <div className="relative bg-white rounded-xl shadow-2xl border border-gray-200 w-[80vw] max-w-[900px] max-h-[80vh] flex flex-col">
              <div className="px-4 py-2.5 border-b border-gray-200">
                <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">Roll back this card?</h2>
              </div>
              <div className="grid grid-cols-2 gap-3 p-4 overflow-auto">
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">Current</p>
                  <div className="border border-gray-200 rounded p-2 text-sm text-gray-800" dangerouslySetInnerHTML={{ __html: cur.front_html }} />
                  {cur.extra && <div className="border border-gray-200 rounded p-2 mt-2 text-xs text-gray-600" dangerouslySetInnerHTML={{ __html: cur.extra }} />}
                </div>
                <div>
                  <p className="text-[10px] font-semibold text-amber-600 uppercase mb-1">Restore — Version {rollbackTarget.index + 1}</p>
                  <div className="border border-amber-200 rounded p-2 text-sm text-gray-800 bg-amber-50/40" dangerouslySetInnerHTML={{ __html: snap.front_html }} />
                  {snap.extra && <div className="border border-amber-200 rounded p-2 mt-2 text-xs text-gray-600 bg-amber-50/40" dangerouslySetInnerHTML={{ __html: snap.extra }} />}
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-gray-200 bg-gray-50/60">
                <button onClick={() => setRollbackTarget(null)} className="px-3 py-1.5 text-xs font-medium text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
                <button onClick={() => handleRollback(rollbackTarget.cardId, rollbackTarget.index)} className="px-3 py-1.5 text-xs font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700">Restore this version</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* In-place split review — proposed new cards from a regenerate→split */}
      {splitProposal && (() => {
        const orig = cards.find(c => c.id === splitProposal.original_card_id) ?? filteredCards.find(c => c.id === splitProposal.original_card_id);
        return (
          <div className="fixed inset-0 z-[70] flex items-center justify-center" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-black/40" onClick={handleSplitCancel} />
            <div className="relative bg-white rounded-xl shadow-2xl border border-gray-200 w-[80vw] max-w-[960px] max-h-[82vh] flex flex-col">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
                <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">Review split — {splitCards.length} new card{splitCards.length !== 1 ? 's' : ''} · double-click to edit</h2>
                <button onClick={handleSplitCancel} className="p-1 text-gray-400 hover:text-gray-600 rounded">✕</button>
              </div>
              <div className="grid grid-cols-2 gap-3 p-4 overflow-auto">
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">Original {splitKeepOriginal ? '(kept)' : '(will be removed)'}</p>
                  {orig ? (
                    <>
                      <div className="border border-gray-200 rounded p-2 text-sm text-gray-800" dangerouslySetInnerHTML={{ __html: orig.front_html }} />
                      {orig.extra && <div className="border border-gray-200 rounded p-2 mt-2 text-xs text-gray-600" dangerouslySetInnerHTML={{ __html: orig.extra }} />}
                    </>
                  ) : <p className="text-xs text-gray-400">(card not loaded)</p>}
                </div>
                <div>
                  <p className="text-[10px] font-semibold text-green-600 uppercase mb-1">New cards (tags &amp; V/TC inherited from the original)</p>
                  <div className="flex flex-col gap-2">
                    {splitCards.length === 0 ? (
                      <p className="text-xs text-gray-400">No new cards proposed.</p>
                    ) : splitCards.map((nc, i) => (
                      <div key={i} className="border border-green-200 rounded p-2 bg-green-50/40">
                        <ProposalEditableField html={nc.front_html} className="text-sm text-gray-800" onSave={(v) => setSplitCards(prev => prev.map((c, idx) => idx === i ? { ...c, front_html: v } : c))} />
                        <div className="border-t border-green-100 mt-1.5 pt-1.5">
                          <span className="text-[9px] text-gray-400 uppercase">Extra</span>
                          <ProposalEditableField html={nc.extra ?? ''} className="text-xs text-gray-600" onSave={(v) => setSplitCards(prev => prev.map((c, idx) => idx === i ? { ...c, extra: v || null } : c))} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-gray-200 bg-gray-50/60">
                <button onClick={handleSplitCancel} className="px-3 py-1.5 text-xs font-medium text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
                <button onClick={handleSplitConfirm} disabled={splitCards.length === 0} className="px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50">Accept — apply changes</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* In-place combine review — N source cards merged into one */}
      {combineProposal && (() => {
        const sources = combineProposal.source_card_ids
          .map(id => cards.find(c => c.id === id) ?? filteredCards.find(c => c.id === id))
          .filter(Boolean) as Card[];
        return (
          <div className="fixed inset-0 z-[70] flex items-center justify-center" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-black/40" onClick={() => setCombineProposal(null)} />
            <div className="relative bg-white rounded-xl shadow-2xl border border-gray-200 w-[80vw] max-w-[960px] max-h-[82vh] flex flex-col">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
                <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">Review combine — {combineProposal.source_card_ids.length} → 1</h2>
                <button onClick={() => setCombineProposal(null)} className="p-1 text-gray-400 hover:text-gray-600 rounded">✕</button>
              </div>
              <div className="grid grid-cols-2 gap-3 p-4 overflow-auto">
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">Originals {splitKeepOriginal ? '(kept)' : '(will be removed)'}</p>
                  <div className="flex flex-col gap-2">
                    {sources.map(c => (
                      <div key={c.id} className="border border-gray-200 rounded p-2">
                        <div className="text-sm text-gray-800" dangerouslySetInnerHTML={{ __html: c.front_html }} />
                        {c.extra && <div className="text-xs text-gray-600 mt-1" dangerouslySetInnerHTML={{ __html: c.extra }} />}
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-[10px] font-semibold text-green-600 uppercase mb-1">Combined card · double-click to edit</p>
                  <div className="border border-green-200 rounded p-2 bg-green-50/40">
                    <ProposalEditableField html={combineProposal.front_html} className="text-sm text-gray-800" onSave={(v) => setCombineProposal({ ...combineProposal, front_html: v })} />
                    <div className="border-t border-green-100 mt-1.5 pt-1.5">
                      <span className="text-[9px] text-gray-400 uppercase">Extra</span>
                      <ProposalEditableField html={combineProposal.extra ?? ''} className="text-xs text-gray-600" onSave={(v) => setCombineProposal({ ...combineProposal, extra: v || null })} />
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-gray-200 bg-gray-50/60">
                <button onClick={() => setCombineProposal(null)} className="px-3 py-1.5 text-xs font-medium text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
                <button onClick={handleCombineConfirm} disabled={!combineProposal.front_html} className="px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50">Accept — apply changes</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Single-card Recreate review — current vs suggested, with retry */}
      {regenProposal && (() => {
        const cur = cards.find(c => c.id === regenProposal.cardId) ?? filteredCards.find(c => c.id === regenProposal.cardId);
        return (
          <div className="fixed inset-0 z-[70] flex items-center justify-center" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-black/40" onClick={() => setRegenProposal(null)} />
            <div className="relative bg-white rounded-xl shadow-2xl border border-gray-200 w-[80vw] max-w-[960px] max-h-[82vh] flex flex-col">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
                <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">Review regenerated card · double-click to edit</h2>
                <button onClick={() => setRegenProposal(null)} className="p-1 text-gray-400 hover:text-gray-600 rounded">✕</button>
              </div>
              <div className="grid grid-cols-2 gap-3 p-4 overflow-auto">
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">Current</p>
                  {cur ? (
                    <>
                      <div className="border border-gray-200 rounded p-2 text-sm text-gray-800" dangerouslySetInnerHTML={{ __html: cur.front_html }} />
                      {cur.extra && <div className="border border-gray-200 rounded p-2 mt-2 text-xs text-gray-600" dangerouslySetInnerHTML={{ __html: cur.extra }} />}
                    </>
                  ) : <p className="text-xs text-gray-400">(card not loaded)</p>}
                </div>
                <div>
                  <p className="text-[10px] font-semibold text-green-600 uppercase mb-1">Suggested</p>
                  <div className="border border-green-200 rounded p-2 bg-green-50/40">
                    <ProposalEditableField html={regenProposal.front_html} className="text-sm text-gray-800" onSave={(v) => setRegenProposal({ ...regenProposal, front_html: v })} />
                    <div className="border-t border-green-100 mt-1.5 pt-1.5">
                      <span className="text-[9px] text-gray-400 uppercase">Extra</span>
                      <ProposalEditableField html={regenProposal.extra ?? ''} className="text-xs text-gray-600" onSave={(v) => setRegenProposal({ ...regenProposal, extra: v || null })} />
                    </div>
                  </div>
                </div>
              </div>
              <div className="px-4 pb-1">
                <div className="flex items-center gap-2">
                  <input
                    value={regenRetryPrompt}
                    onChange={(e) => setRegenRetryPrompt(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleRegenPreview(regenProposal.cardId, regenRetryPrompt); } }}
                    placeholder="Adjust the guidance and retry…"
                    className="flex-1 text-xs border border-gray-200 rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-amber-500"
                  />
                  <button onClick={() => handleRegenPreview(regenProposal.cardId, regenRetryPrompt)} disabled={regenPreviewLoading} className="px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 disabled:opacity-50">{regenPreviewLoading ? 'Generating…' : 'Retry'}</button>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-gray-200 bg-gray-50/60">
                <button onClick={() => setRegenProposal(null)} className="px-3 py-1.5 text-xs font-medium text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
                <button onClick={handleRegenAccept} disabled={!regenProposal.front_html || regenPreviewLoading} className="px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50">Accept</button>
              </div>
            </div>
          </div>
        );
      })()}

      {showCreatePresentation && (
        <CreatePresentationModal
          selectedCardIds={[...selectedIds]}
          topicTreeId={topicTreeId ?? null}
          onCreated={(p) => {
            setShowCreatePresentation(false);
            window.open(`/anki/${p.slug}`, '_blank');
          }}
          onClose={() => setShowCreatePresentation(false)}
        />
      )}

      {/* Create Fix Batch modal */}
      {showFixBatchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !fixBatchStarted && setShowFixBatchModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[520px] overflow-hidden" onClick={e => e.stopPropagation()}>
            {fixBatchStarted ? (
              <>
                <div className="px-6 py-8 text-center">
                  <div className="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center mx-auto mb-3">
                    <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h2 className="text-sm font-bold text-gray-900 mb-1">AI Fix Running</h2>
                  <p className="text-xs text-gray-500">
                    {fixBatchCardIds.length} card{fixBatchCardIds.length !== 1 ? 's' : ''} are being reviewed by AI.
                    Go to Proposals to review results when done.
                  </p>
                </div>
                <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 flex justify-end gap-2">
                  <button onClick={() => setShowFixBatchModal(false)} className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">Close</button>
                  <a href="/proposals" className="px-4 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 inline-flex items-center" onClick={() => setShowFixBatchModal(false)}>
                    View Proposals →
                  </a>
                </div>
              </>
            ) : (
              <>
                <div className="px-6 py-4 border-b border-gray-200">
                  <h2 className="text-sm font-bold text-gray-900">Start AI Fix Batch</h2>
                  <p className="text-xs text-gray-500 mt-0.5">{fixBatchCardIds.length} card{fixBatchCardIds.length !== 1 ? 's' : ''} · AI will review and fix each card based on your instructions</p>
                </div>
                <div className="px-6 py-4 space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Issue type</label>
                    <select
                      value={fixBatchMarkId ?? ''}
                      onChange={e => setFixBatchMarkId(e.target.value ? Number(e.target.value) : null)}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">— select a mark type —</option>
                      {markTypes.map(m => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Fix instructions</label>
                    <textarea
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 min-h-[120px] resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Describe the fix. E.g. 'Reduce to at most 2 cloze deletions per card. Keep the most important concept as the cloze.'"
                      value={fixBatchPrompt}
                      onChange={e => setFixBatchPrompt(e.target.value)}
                      autoFocus
                    />
                  </div>
                </div>
                <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 flex justify-end gap-2">
                  <button onClick={() => setShowFixBatchModal(false)} className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
                  <button
                    onClick={handleCreateFixBatch}
                    disabled={!fixBatchMarkId || !fixBatchPrompt.trim() || fixBatchLoading}
                    className="px-4 py-1.5 text-xs font-medium text-white bg-purple-700 rounded-lg hover:bg-purple-800 disabled:opacity-50"
                  >
                    {fixBatchLoading ? 'Starting...' : 'Start AI Fix'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {viewSectionId != null && (
        <SectionViewer sectionId={viewSectionId} onClose={() => setViewSectionId(null)} initialVariant="left" />
      )}

      {/* Validator before/after + revert */}
      {validationView && (() => {
        const vcv = vcEntryFor(validationView, activeCardVersion);
        if (!vcv) return null;
        const verLabel = activeCardVersion === 'base' ? 'Base' : activeCardVersion.toUpperCase();
        const afterFront = getFieldValue(validationView, 'front_html', activeCardVersion);
        const afterExtra = getFieldValue(validationView, 'extra', activeCardVersion);
        return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setValidationView(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl border border-gray-200 w-[720px] max-w-[94vw] max-h-[88vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
              <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">
                <span className="text-violet-600">{verLabel}</span> · {vcv.action === 'split' ? 'Split from original' : 'Validator auto-fix — before / after'}
              </h2>
              <button onClick={() => setValidationView(null)} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-4">
              <div>
                <div className="text-[11px] font-semibold text-gray-500 uppercase mb-1">
                  {vcv.action === 'split' ? 'Original (overloaded) card' : 'Before'}
                </div>
                <div className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-2" dangerouslySetInnerHTML={{ __html: vcv.prev_front_html }} />
                {vcv.prev_extra && (
                  <div className="text-[11px] text-gray-500 mt-1"><span className="font-semibold">Extra:</span> <span dangerouslySetInnerHTML={{ __html: vcv.prev_extra }} /></div>
                )}
              </div>
              <div>
                <div className="text-[11px] font-semibold text-gray-500 uppercase mb-1">
                  {vcv.action === 'split' ? 'This sibling card now' : 'After'}
                </div>
                <div className="text-xs bg-violet-50 border border-violet-200 rounded-lg p-2" dangerouslySetInnerHTML={{ __html: afterFront }} />
                {afterExtra && (
                  <div className="text-[11px] text-gray-500 mt-1"><span className="font-semibold">Extra:</span> <span dangerouslySetInnerHTML={{ __html: afterExtra }} /></div>
                )}
              </div>
              {vcv.action === 'split' && (
                <p className="text-[11px] text-gray-400">This card was created by auto-splitting the original above. To undo a split, select the sibling cards and use Combine.</p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-gray-200">
              {vcv.action === 'fixed' && (
                <button
                  onClick={async () => {
                    try {
                      await revertValidation(validationView.id, activeCardVersion);
                      setValidationView(null);
                      fetchCards(sectionId, topicPath, true, undefined, sectionIds);
                    } catch { setActionError('Revert failed'); }
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700"
                >
                  ↩ Revert {verLabel} to before
                </button>
              )}
              <button onClick={() => setValidationView(null)} className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-lg">Close</button>
            </div>
          </div>
        </div>
        );
      })()}


      {/* Correctness rules reference */}
      {showRulesModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowRulesModal(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl border border-gray-200 w-[640px] max-w-[94vw] max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
              <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">What "Validate" checks ({validationRules.length} rules)</h2>
              <button onClick={() => setShowRulesModal(false)} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-3">
              {validationRules.map((r, i) => (
                <div key={r.key}>
                  <div className="text-xs font-semibold text-gray-800">{i + 1}. {r.title} <span className="text-[10px] font-normal text-gray-400">({r.key})</span></div>
                  <div className="text-[11px] text-gray-600 mt-0.5">{r.criteria}</div>
                </div>
              ))}
              <p className="text-[11px] text-gray-400 pt-1 border-t border-gray-100">The score badge shows passed/total. A card flagged for splitting (single concept) is auto-split into sibling cards; other failures are auto-fixed in up to 3 retries.</p>
            </div>
          </div>
        </div>
      )}

      {/* Bulk regenerate modal */}
      {showBulkRegenModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { if (!bulkRegenProgress) setShowBulkRegenModal(false); }}>
          <div className="bg-white rounded-xl shadow-2xl w-[420px] p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Regenerate {bulkRegenScope === 'all' ? `all ${totalCards}` : selectedIds.size} cards</h3>
            {/* Mode: Recreate (1:1) · Split (1→N, single card) · Combine (N→1, coming next) */}
            <div className="flex items-center gap-1 mb-3 border border-gray-200 rounded-lg p-0.5 w-fit">
              <button
                onClick={() => setRegenMode('recreate')}
                disabled={!!bulkRegenProgress || splitLoading}
                className={`px-2.5 py-1 text-[11px] font-medium rounded ${regenMode === 'recreate' ? 'bg-amber-50 text-amber-700' : 'text-gray-500 hover:bg-gray-50'}`}
              >Recreate</button>
              {bulkRegenScope === 'selected' && selectedIds.size === 1 ? (
                <button
                  onClick={() => setRegenMode('split')}
                  disabled={!!bulkRegenProgress || splitLoading}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded ${regenMode === 'split' ? 'bg-amber-50 text-amber-700' : 'text-gray-500 hover:bg-gray-50'}`}
                >Split into multiple</button>
              ) : (
                <button disabled title="Select exactly one card to split" className="px-2.5 py-1 text-[11px] font-medium rounded text-gray-300 cursor-not-allowed">Split</button>
              )}
              {bulkRegenScope === 'selected' && selectedIds.size > 1 ? (
                <button
                  onClick={() => setRegenMode('combine')}
                  disabled={!!bulkRegenProgress || combineLoading}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded ${regenMode === 'combine' ? 'bg-amber-50 text-amber-700' : 'text-gray-500 hover:bg-gray-50'}`}
                >Combine into one</button>
              ) : (
                <button disabled title="Select two or more cards to combine" className="px-2.5 py-1 text-[11px] font-medium rounded text-gray-300 cursor-not-allowed">Combine</button>
              )}
            </div>
            {(regenMode === 'split' || regenMode === 'combine') && (
              <div className="flex items-center gap-3 mb-3 text-[11px] text-gray-600">
                <span>Original card{regenMode === 'combine' ? 's' : ''} after this:</span>
                <label className="flex items-center gap-1 cursor-pointer"><input type="radio" checked={!splitKeepOriginal} onChange={() => setSplitKeepOriginal(false)} />Delete</label>
                <label className="flex items-center gap-1 cursor-pointer"><input type="radio" checked={splitKeepOriginal} onChange={() => setSplitKeepOriginal(true)} />Keep</label>
              </div>
            )}
            <p className="text-xs text-gray-500 mb-3">
              {regenMode === 'split'
                ? `This card will be split into multiple cards using ${selectedModel}; you'll review before anything changes.`
                : regenMode === 'combine'
                  ? `These ${selectedIds.size} cards will be merged into one using ${selectedModel}; you'll review before anything changes.`
                  : `Cards will be regenerated one by one using ${selectedModel}. You can optionally provide guidance.`}
            </p>
            <textarea
              value={bulkRegenPrompt}
              onChange={(e) => setBulkRegenPrompt(e.target.value)}
              placeholder={regenMode === 'split'
                ? "How should it be split? e.g. 'one card per organism' or 'separate diagnosis from treatment'…"
                : regenMode === 'combine'
                  ? "How should they be merged? e.g. 'into one summary card', 'keep the key differences'… (optional)"
                  : "Optional guidance — e.g. 'make cards more specific' or 'focus on diagnostic criteria'..."}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs focus:outline-none focus:border-amber-500 resize-none"
              rows={3}
              disabled={!!bulkRegenProgress || splitLoading || combineLoading}
            />
            {bulkRegenProgress && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
                  <span>Regenerating...</span>
                  <span>{bulkRegenProgress.done} / {bulkRegenProgress.total}</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-1.5">
                  <div className="bg-amber-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${(bulkRegenProgress.done / bulkRegenProgress.total) * 100}%` }} />
                </div>
              </div>
            )}
            <div className="mt-4 flex gap-2 justify-end">
              <button
                onClick={() => { setShowBulkRegenModal(false); setBulkRegenPrompt(''); }}
                disabled={!!bulkRegenProgress || splitLoading || combineLoading}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (regenMode === 'split') handleSplitStart();
                  else if (regenMode === 'combine') handleCombineStart();
                  else if (bulkRegenScope === 'selected' && selectedIds.size === 1) {
                    setRegenRetryPrompt(bulkRegenPrompt);
                    handleRegenPreview([...selectedIds][0], bulkRegenPrompt);
                  } else handleBulkRegen(bulkRegenPrompt, bulkRegenScope);
                }}
                disabled={!!bulkRegenProgress || splitLoading || combineLoading || regenPreviewLoading}
                className="px-3 py-1.5 text-xs font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50"
              >
                {splitLoading
                  ? 'Splitting…'
                  : combineLoading
                    ? 'Combining…'
                    : regenPreviewLoading
                      ? 'Generating…'
                      : bulkRegenProgress
                        ? `Working... (${bulkRegenProgress.done}/${bulkRegenProgress.total})`
                        : regenMode === 'split'
                          ? 'Split card'
                          : regenMode === 'combine'
                            ? 'Combine cards'
                            : bulkRegenScope === 'all' ? 'Regenerate All' : 'Regenerate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
