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
  bulkMarkCards,
  bulkScoreCards,
  createFixBatch,
  getSection,
  uploadSectionImage,
  uploadSectionImageFromUrl,
} from '../api';
import type { Card, CardStatus, CostEstimate, ReviewMarkType, SectionImage } from '../types';
import ConfirmModal from '../components/ConfirmModal';
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
  // When provided, double-click / Enter opens the big editor modal instead of
  // the inline textarea (keeps the cell readable for long card/vignette text).
  onRequestEdit?: () => void;
}

function EditableCell({ value, cellId, onSave, onSelect, onNavigate, multiline, renderDisplay, onRequestEdit }: EditableCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [localVal, setLocalVal] = useState(value);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setLocalVal(value); }, [value]);

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  useEffect(() => {
    if (isEditing && taRef.current) autoResize(taRef.current);
  }, [isEditing, localVal]);

  // Route editing to the big modal when a handler is wired; otherwise edit inline.
  function startEdit() { if (onRequestEdit) { onRequestEdit(); return; } setLocalVal(value); setIsEditing(true); }
  function save() { setIsEditing(false); if (localVal !== value) onSave(localVal); }
  function cancel() { setIsEditing(false); setLocalVal(value); }

  if (isEditing) {
    return multiline ? (
      <textarea
        ref={taRef}
        className="w-full text-sm bg-white border-0 outline-none p-0 leading-relaxed resize-none"
        value={localVal}
        onChange={(e) => { setLocalVal(e.target.value); autoResize(e.target); }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          if (e.key === 'Tab') { e.preventDefault(); save(); }
        }}
        autoFocus
      />
    ) : (
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
  { key: 'vignette', label: 'Vignette' },
  { key: 'teaching_case', label: 'Teaching Case' },
];

function frontFieldFor(v: CardVersion): string {
  return v === 'v1' ? 'front_html_v1' : v === 'v2' ? 'front_html_v2' : v === 'v3' ? 'front_html_v3' : 'front_html';
}
function getFieldValue(card: Card, key: string, ver: CardVersion): string {
  if (key === 'front_html') return (((card as any)[frontFieldFor(ver)] ?? card.front_html) ?? '') as string;
  return (((card as any)[key]) ?? '') as string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fieldPatch(key: string, val: string, ver: CardVersion): any {
  if (key === 'front_html') return { [frontFieldFor(ver)]: val };
  return { [key]: val || null };  // extra/vignette/teaching_case null out when blank
}

interface BigEditModalProps {
  cards: Card[];
  cardId: number;
  field: string;
  activeCardVersion: CardVersion;
  enableCardNav: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSave: (id: number, patch: any) => void;
  onClose: () => void;
}

function BigEditModal({ cards, cardId: startId, field: startField, activeCardVersion, enableCardNav, onSave, onClose }: BigEditModalProps) {
  const [cardId, setCardId] = useState(startId);
  const [fieldKey, setFieldKey] = useState(startField);
  const [draft, setDraft] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const idx = cards.findIndex((c) => c.id === cardId);
  const card = idx >= 0 ? cards[idx] : undefined;

  // Reload the draft when the (card, field) target changes — not on background
  // refreshes, so we never clobber what the user is typing.
  useEffect(() => {
    if (card) setDraft(getFieldValue(card, fieldKey, activeCardVersion));
    requestAnimationFrame(() => taRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, fieldKey]);

  if (!card) return null;

  function flush() {
    if (!card) return;
    const orig = getFieldValue(card, fieldKey, activeCardVersion);
    if (draft !== orig) onSave(card.id, fieldPatch(fieldKey, draft, activeCardVersion));
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
          <span className="text-[11px] text-gray-400">Click outside or Save keeps changes · Esc cancels · ⌘/Ctrl+Enter saves & closes</span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs font-medium text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
            <button onClick={saveClose} className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">Save &amp; Close</button>
          </div>
        </div>
      </div>
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
          : <div className="flex flex-wrap gap-1">
              {tags.map(tag => (
                <span key={tag} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200 font-medium">{tag}</span>
              ))}
            </div>
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
              placeholder="tag1, tag2"
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
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100 transition-colors duration-150"
            >
              <span className="truncate max-w-[80px]">{activeTags[0]}</span>
              {activeTags.length > 1 && <span className="bg-blue-200 text-blue-700 rounded px-1 text-[10px] font-semibold">+{activeTags.length - 1}</span>}
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
              <div className="flex flex-wrap gap-1">
                {activeTags.map((tag) => (
                  <span key={tag} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200 font-medium">{tag}</span>
                ))}
              </div>
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
  const [totalCards, setTotalCards] = useState(0);
  const [cardsLoading, setCardsLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });
  const [statusFilter, setStatusFilter] = useState<'all' | CardStatus>('all');

  // ── Search + display mode ────────────────────────────────────────────────
  const [searchQ, setSearchQ] = useState('');
  const [showAnkiFormat, setShowAnkiFormat] = useState(false);

  // ── Tile view editing ────────────────────────────────────────────────────
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFrontHtml, setEditFrontHtml] = useState('');
  const [editTags, setEditTags] = useState('');

  // ── Per-card regenerate ──────────────────────────────────────────────────
  const [regenLoading, setRegenLoading] = useState(false);

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
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [showActionsMenu, setShowActionsMenu] = useState(false);
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
  const fetchCards = useCallback(
    async (secId: number | null, topic?: string | null, silent?: boolean, page?: number, secIds?: number[] | null) => {
      if (!silent) setCardsLoading(true);
      const pageSize = pagination.pageSize;
      const offset = (page ?? pagination.pageIndex) * pageSize;
      const filters = {
        limit: pageSize,
        offset,
        ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
        ...(markFilterId != null ? { mark_type_id: markFilterId } : {}),
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
          setCards([]);
          setTotalCards(0);
          if (!silent) setCardsLoading(false);
          return;
        }
        setCards(resp.cards);
        setTotalCards(resp.total);
        setActionError(null);
      } catch {
        // surface the failure — an empty table otherwise reads as "no cards"
        setActionError('Failed to load cards — check that the backend is running');
      } finally {
        if (!silent) setCardsLoading(false);
      }
    },
    [pagination.pageSize, pagination.pageIndex, statusFilter, markFilterId]
  );

  // Refetch on dependencies change
  useEffect(() => {
    setPagination((p) => ({ ...p, pageIndex: 0 }));
    fetchCards(sectionId, topicPath, false, undefined, sectionIds);
    setSearchQ('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId, topicPath, sectionIds, refreshKey, statusFilter, markFilterId]);

  // Refetch on page change
  useEffect(() => {
    fetchCards(sectionId, topicPath, true, pagination.pageIndex, sectionIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagination.pageIndex]);

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
            className="rounded border-gray-300 text-blue-700 focus:ring-blue-500"
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
            className="rounded border-gray-300 text-blue-700 focus:ring-blue-500"
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
                {card.accuracy_score != null && (
                  <span
                    className={`w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white shrink-0 ${
                      card.accuracy_score >= 5 ? 'bg-green-500' :
                      card.accuracy_score >= 4 ? 'bg-blue-500' :
                      card.accuracy_score >= 3 ? 'bg-amber-500' :
                      card.accuracy_score >= 2 ? 'bg-red-500' :
                      'bg-red-800'
                    }`}
                    title={`Accuracy: ${card.accuracy_score}/5${card.accuracy_note && card.accuracy_note !== 'Accurate' ? ` — ${card.accuracy_note}` : ''}${card.eor_yield ? `\nEOR: ${Object.entries(card.eor_yield).map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''}`}
                  >
                    {card.accuracy_score}
                  </span>
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
          // Pick the right version to display; fall back to base if version not generated
          const versionedHtml =
            activeCardVersion === 'v1' ? card.front_html_v1 :
            activeCardVersion === 'v2' ? card.front_html_v2 :
            activeCardVersion === 'v3' ? card.front_html_v3 :
            card.front_html;
          const displayHtml = versionedHtml || card.front_html;
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
              onRequestEdit={() => setBigEdit({ cardId: card.id, field: 'front_html', nav: true })}
              multiline
              renderDisplay={(v) => (
                <div className="relative">
                  {isVersionMissing && (
                    <span className="absolute top-0 right-0 text-[9px] px-1 py-0.5 rounded bg-gray-100 text-gray-400">base</span>
                  )}
                  <div
                    className="text-sm leading-relaxed text-gray-800"
                    dangerouslySetInnerHTML={{
                      __html: showAnkiFormat ? renderClozeHtml(v) : v,
                    }}
                  />
                </div>
              )}
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
        header: 'Extra',
        size: 200,
        cell: (info) => {
          const row = info.row;
          const val = info.getValue() ?? '';
          const cellId = `${row.index}:extra`;
          return (
            <EditableCell
              value={val}
              cellId={cellId}
              onSave={(newVal) => handleCellSave(row.original.id, { extra: newVal || null })}
              onSelect={handleCellSelect}
              onNavigate={(dir) => handleCellNavigate(row.index, 'extra', dir)}
              onRequestEdit={() => setBigEdit({ cardId: row.original.id, field: 'extra', nav: true })}
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
              onRequestEdit={() => setBigEdit({ cardId: row.original.id, field: 'vignette', nav: true })}
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
              onRequestEdit={() => setBigEdit({ cardId: row.original.id, field: 'teaching_case', nav: true })}
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
    [filteredCards.length, selectedIds, handleCellSelect, handleCellNavigate, handleCellSave, showAnkiFormat, sectionId, sectionIds, topicPath, onReviewChange, fetchCards, markTypes, activeTagSet, activeCardVersion]
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
      const params: { rule_set_id: number; model: string; section_ids?: number[]; topic_tree_id?: number } = {
        rule_set_id: selectedRuleSetId,
        model: selectedModel,
      };
      if (sectionId) params.section_ids = [sectionId];
      else if (sectionIds && sectionIds.length > 0) params.section_ids = sectionIds;
      else if (topicTreeId) params.topic_tree_id = topicTreeId;
      const est = await estimateCost(params);
      setEstimate(est);
    } catch {
      setJobError('Estimate failed');
    } finally {
      setEstimating(false);
    }
  }, [selectedRuleSetId, selectedModel, sectionId, sectionIds, topicTreeId]);

  const handleGenerate = useCallback(async () => {
    if (!selectedRuleSetId || !selectedModel) return;
    setShowGenerateConfirm(false);
    setJobRunning(true);
    setJobProgress(null);
    setJobError(null);
    try {
      const params: { rule_set_id: number; model: string; section_ids?: number[]; topic_tree_id?: number; replace_existing?: boolean } = {
        rule_set_id: selectedRuleSetId,
        model: selectedModel,
      };
      if (sectionId) params.section_ids = [sectionId];
      else if (sectionIds && sectionIds.length > 0) params.section_ids = sectionIds;
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
    setEditTags(tagsForEdit.join(', '));
  }, [activeTagSet]);

  const handleSaveEdit = useCallback(async (id: number) => {
    try {
      const tags = editTags.split(',').map((t) => t.trim()).filter(Boolean);
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
      await regenerateCard(id, { model: selectedModel, prompt: prompt || undefined });
      fetchCards(sectionId, topicPath, true);
      refreshUsage?.();
    } catch {
      setActionError('Regeneration failed');
    } finally {
      setRegenLoading(false);
    }
  }, [selectedModel, fetchCards, sectionId, topicPath, refreshUsage]);

  const [showBulkRegenModal, setShowBulkRegenModal] = useState(false);
  const [bulkRegenPrompt, setBulkRegenPrompt] = useState('');
  const [bulkRegenProgress, setBulkRegenProgress] = useState<{ done: number; total: number } | null>(null);

  const [bulkRegenScope, setBulkRegenScope] = useState<'selected' | 'all'>('selected');

  const handleBulkRegen = useCallback(async (prompt: string, scope: 'selected' | 'all') => {
    let ids: number[];
    if (scope === 'all') {
      // Fetch all card IDs for the current context
      try {
        const allParams: Parameters<typeof getCards>[0] = { limit: 10000, offset: 0 };
        if (sectionId) allParams.section_id = sectionId;
        else if (sectionIds && sectionIds.length > 0) allParams.section_ids = sectionIds.join(',');
        const resp = await getCards(allParams);
        ids = resp.cards.map(c => c.id);
      } catch {
        setActionError('Failed to fetch all cards');
        return;
      }
    } else {
      ids = [...selectedIds];
    }
    if (ids.length === 0) return;
    setBulkRegenProgress({ done: 0, total: ids.length });
    try {
      for (let i = 0; i < ids.length; i++) {
        await regenerateCard(ids[i], { model: selectedModel, prompt: prompt || undefined });
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
  }, [selectedIds, selectedModel, sectionId, sectionIds, fetchCards, topicPath, refreshUsage, onReviewChange]);

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

  // ── Empty state ──────────────────────────────────────────────────────────

  const hasContext = sectionId != null || topicPath != null || (sectionIds != null && sectionIds.length > 0);

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
  const exportUrl = topicTreeId
    ? exportCardsUrl({ topic_tree_id: topicTreeId })
    : topicPath
      ? exportCardsUrl({ topic_path: topicPath })
      : undefined;

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
              <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 min-w-[200px] py-1">
                <button onClick={() => { setShowActionsMenu(false); setAnkifyOpen(true); }} className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                  Ankify
                </button>
                <button onClick={() => { setShowActionsMenu(false); setShowCreatePresentation(true); }} className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                  Save Presentation
                </button>
                <div className="border-t border-gray-100 my-1" />
                <button onClick={() => { setShowActionsMenu(false); setBulkRegenScope('selected'); setShowBulkRegenModal(true); }} className="w-full text-left px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-50">
                  Regenerate — selected ({selectedIds.size})
                </button>
                {(sectionId || (sectionIds && sectionIds.length > 0)) && (
                  <button onClick={() => { setShowActionsMenu(false); setBulkRegenScope('all'); setShowBulkRegenModal(true); }} className="w-full text-left px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-50">
                    Regenerate — all in topic ({totalCards})
                  </button>
                )}
                <button
                  onClick={() => { setShowActionsMenu(false); handleGenSupplemental('selected'); }}
                  disabled={jobRunning || !selectedRuleSetId}
                  className="w-full text-left px-3 py-1.5 text-xs text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                >
                  Gen Vignettes &amp; Cases — selected ({selectedIds.size})
                </button>
                {(sectionId || (sectionIds && sectionIds.length > 0)) && (
                  <button
                    onClick={() => { setShowActionsMenu(false); handleGenSupplemental('all'); }}
                    disabled={jobRunning || !selectedRuleSetId}
                    className="w-full text-left px-3 py-1.5 text-xs text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                  >
                    Gen Vignettes &amp; Cases — all in topic
                  </button>
                )}
                <div className="border-t border-gray-100 my-1" />
                <button
                  onClick={async () => {
                    setShowActionsMenu(false);
                    if (selectedIds.size === 0) return;
                    setScoring(true);
                    try {
                      await bulkScoreCards({ card_ids: [...selectedIds], model: selectedModel });
                      fetchCards(sectionId, topicPath, true, undefined, sectionIds);
                    } catch { setActionError('Scoring failed'); } finally { setScoring(false); }
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-teal-700 hover:bg-teal-50"
                >
                  Score Cards — selected ({selectedIds.size})
                </button>
                {(sectionId || (sectionIds && sectionIds.length > 0)) && (
                  <button
                    onClick={async () => {
                      setShowActionsMenu(false);
                      setScoring(true);
                      try {
                        const allCards = await getCards({
                          ...(sectionId ? { section_id: sectionId } : {}),
                          ...(sectionIds && sectionIds.length > 0 ? { section_ids: sectionIds.join(',') } : {}),
                          ...(!sectionId && !sectionIds?.length && topicPath ? { topic: topicPath } : {}),
                          limit: 10000, offset: 0,
                        });
                        const allIds = allCards.cards.map(c => c.id);
                        if (allIds.length === 0) return;
                        await bulkScoreCards({ card_ids: allIds, model: selectedModel });
                        fetchCards(sectionId, topicPath, true, undefined, sectionIds);
                      } catch { setActionError('Scoring failed'); } finally { setScoring(false); }
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs text-teal-700 hover:bg-teal-50"
                  >
                    Score Cards — all in topic ({totalCards})
                  </button>
                )}
                <div className="border-t border-gray-100 my-1" />
                {markTypes.length > 0 && (
                  <>
                    <p className="px-3 py-1 text-[9px] font-semibold text-gray-400 uppercase tracking-wide">Mark as</p>
                    {markTypes.map(m => (
                      <button key={m.id} onClick={() => { setShowActionsMenu(false); handleBulkMark(m.id); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 text-left">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
                        {m.name}
                      </button>
                    ))}
                    <button onClick={() => { setShowActionsMenu(false); handleBulkMark(null); }} className="w-full px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 text-left">
                      Clear mark
                    </button>
                    <div className="border-t border-gray-100 my-1" />
                    <button
                      onClick={() => { setShowActionsMenu(false); setFixBatchMarkId(markFilterId ?? (markTypes[0]?.id ?? null)); setFixBatchPrompt(''); setShowFixBatchModal(true); }}
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
              <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 min-w-[170px] py-1">
                <a
                  href={exportCardsUrl({ card_ids: [...selectedIds] })}
                  className="block px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                  download
                  onClick={() => setShowExportMenu(false)}
                >
                  Selected only ({selectedIds.size})
                </a>
                {exportUrl && (
                  <a
                    href={exportUrl}
                    className="block px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                    download
                    onClick={() => setShowExportMenu(false)}
                  >
                    All cards in topic
                  </a>
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
          {(jobRunning || bulkRegenProgress || scoring) && (
            <div className="flex items-center gap-1.5 ml-2 text-[10px] text-blue-600">
              <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span>{bulkRegenProgress ? `Regen ${bulkRegenProgress.done}/${bulkRegenProgress.total}` : scoring ? 'Scoring...' : 'Generating...'}</span>
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
          message={`Generate cards for this section using ${selectedModel}?${estimate ? ` Estimated cost: $${estimate.estimated_cost_usd.toFixed(3)}` : ''}`}
          confirmLabel="Generate"
          onConfirm={handleGenerate}
          onCancel={() => setShowGenerateConfirm(false)}
        />
      )}

      {ankifyOpen && (
        <AnkifyModal
          cards={selectedIds.size > 0 ? cards.filter(c => selectedIds.has(c.id)) : filteredCards}
          onClose={() => setAnkifyOpen(false)}
        />
      )}

      {bigEdit && (
        <BigEditModal
          cards={filteredCards}
          cardId={bigEdit.cardId}
          field={bigEdit.field}
          activeCardVersion={activeCardVersion}
          enableCardNav={bigEdit.nav}
          onSave={handleCellSave}
          onClose={() => setBigEdit(null)}
        />
      )}

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
        <SectionViewer sectionId={viewSectionId} onClose={() => setViewSectionId(null)} />
      )}

      {/* Bulk regenerate modal */}
      {showBulkRegenModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { if (!bulkRegenProgress) setShowBulkRegenModal(false); }}>
          <div className="bg-white rounded-xl shadow-2xl w-[420px] p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Regenerate {bulkRegenScope === 'all' ? `all ${totalCards}` : selectedIds.size} cards</h3>
            <p className="text-xs text-gray-500 mb-3">Cards will be regenerated one by one using {selectedModel}. You can optionally provide guidance.</p>
            <textarea
              value={bulkRegenPrompt}
              onChange={(e) => setBulkRegenPrompt(e.target.value)}
              placeholder="Optional guidance — e.g. 'make cards more specific' or 'focus on diagnostic criteria'..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs focus:outline-none focus:border-amber-500 resize-none"
              rows={3}
              disabled={!!bulkRegenProgress}
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
                disabled={!!bulkRegenProgress}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleBulkRegen(bulkRegenPrompt, bulkRegenScope)}
                disabled={!!bulkRegenProgress}
                className="px-3 py-1.5 text-xs font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50"
              >
                {bulkRegenProgress ? `Working... (${bulkRegenProgress.done}/${bulkRegenProgress.total})` : 'Regenerate All'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
