import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
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
  bulkMarkReviewed,
  bulkDeleteCards,
  estimateCost,
  startGeneration,
  getGenerationJob,
  getActiveJobs,
  startSupplemental,
} from '../api';
import type { Card, CardStatus, CostEstimate } from '../types';
import ConfirmModal from '../components/ConfirmModal';
import AlertModal from '../components/AlertModal';
import AnkifyModal from '../components/AnkifyModal';
import { useSettings } from '../context/SettingsContext';

interface CardsPanelProps {
  sectionId: number | null;
  topicPath?: string | null;
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
}

function EditableCell({ value, cellId, onSave, onSelect, onNavigate, multiline, renderDisplay }: EditableCellProps) {
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

  function startEdit() { setLocalVal(value); setIsEditing(true); }
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

// ── TagsCell ───────────────────────────────────────────────────────────────────
interface TagsCellProps {
  tags: string[];
  cellId: string;
  onSave: (tags: string[]) => void;
  onSelect: (cellId: string) => void;
  onNavigate: (dir: 'up' | 'down' | 'left' | 'right') => void;
}

function TagsCell({ tags, cellId, onSave, onSelect, onNavigate }: TagsCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [localVal, setLocalVal] = useState(tags.join(', '));

  useEffect(() => { setLocalVal(tags.join(', ')); }, [tags]);

  function startEdit() { setLocalVal(tags.join(', ')); setIsEditing(true); }
  function save() {
    setIsEditing(false);
    const newTags = localVal.split(',').map(t => t.trim()).filter(Boolean);
    if (JSON.stringify(newTags) !== JSON.stringify(tags)) onSave(newTags);
  }
  function cancel() { setIsEditing(false); setLocalVal(tags.join(', ')); }

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
      data-cell-id={cellId}
      tabIndex={0}
      className="cursor-default outline-none w-full h-full flex flex-wrap gap-1 min-h-[1.5em]"
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
      {tags.length === 0
        ? <span className="text-gray-300 text-xs">—</span>
        : tags.map(tag => (
            <span key={tag} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200 font-medium">{tag}</span>
          ))
      }
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
}: CardTileProps) {
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
          {card.tags.length === 0 ? (
            <span className="text-gray-300 text-xs">--</span>
          ) : (
            <button
              onClick={(e) => openPopover('tags', e)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100 transition-colors duration-150"
            >
              <span className="truncate max-w-[80px]">{card.tags[0]}</span>
              {card.tags.length > 1 && <span className="bg-blue-200 text-blue-700 rounded px-1 text-[10px] font-semibold">+{card.tags.length - 1}</span>}
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
                {card.tags.map((tag) => (
                  <span key={tag} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200 font-medium">{tag}</span>
                ))}
              </div>
            </div>
          )}
          {popover.kind === 'actions' && (
            <div className="fixed z-50 bg-white border border-gray-200 rounded-xl shadow-xl py-1 min-w-[160px]" style={{ top: popover.y, left: Math.max(8, popover.x - 120) }}>
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
  topicTreeId,
  refreshKey,
  refreshUsage,
  onReviewChange,
}: CardsPanelProps) {
  const { selectedModel, selectedRuleSetId } = useSettings();

  // ── Generation controls ──────────────────────────────────────────────────
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [jobRunning, setJobRunning] = useState(false);
  const [jobProgress, setJobProgress] = useState<{ processed: number; total: number } | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [jobAlertError, setJobAlertError] = useState<string | null>(null);
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

  // ── Ankify modal ─────────────────────────────────────────────────────────
  const [ankifyOpen, setAnkifyOpen] = useState(false);

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

  // ── Filtered cards ───────────────────────────────────────────────────────
  const filteredCards = useMemo(() => {
    if (!searchQ.trim()) return cards;
    const q = searchQ.toLowerCase();
    return cards.filter(c =>
      (c.front_text ?? stripHtml(c.front_html)).toLowerCase().includes(q) ||
      c.tags.some(t => t.toLowerCase().includes(q))
    );
  }, [cards, searchQ]);

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
    async (secId: number | null, topic?: string | null, silent?: boolean, page?: number) => {
      if (!silent) setCardsLoading(true);
      const pageSize = pagination.pageSize;
      const offset = (page ?? pagination.pageIndex) * pageSize;
      try {
        let resp;
        if (secId != null) {
          resp = await getCards({
            section_id: secId,
            limit: pageSize,
            offset,
            ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
          });
        } else if (topic) {
          resp = await getCards({
            topic,
            limit: pageSize,
            offset,
            ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
          });
        } else {
          setCards([]);
          setTotalCards(0);
          if (!silent) setCardsLoading(false);
          return;
        }
        setCards(resp.cards);
        setTotalCards(resp.total);
      } catch {
        // silently fail
      } finally {
        if (!silent) setCardsLoading(false);
      }
    },
    [pagination.pageSize, pagination.pageIndex, statusFilter]
  );

  // Refetch on dependencies change
  useEffect(() => {
    setPagination((p) => ({ ...p, pageIndex: 0 }));
    fetchCards(sectionId, topicPath);
    setSearchQ('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId, topicPath, refreshKey, statusFilter]);

  // Refetch on page change
  useEffect(() => {
    fetchCards(sectionId, topicPath, true, pagination.pageIndex);
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
        size: 50,
        enableResizing: false,
        cell: (info) => (
          <div className="flex items-center gap-1">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                info.row.original.status === 'rejected' ? 'bg-red-400' :
                info.row.original.is_reviewed ? 'bg-gray-300' : 'bg-amber-400'
              }`}
              title={
                info.row.original.status === 'rejected' ? 'Rejected' :
                info.row.original.is_reviewed ? 'Reviewed' : 'Pending'
              }
            />
            <span className={`text-xs tabular-nums ${!info.row.original.is_reviewed ? 'font-bold' : 'text-gray-400'}`}>
              {info.getValue()}
            </span>
          </div>
        ),
      }),
      columnHelper.accessor('front_html', {
        header: 'Card',
        size: 400,
        cell: (info) => {
          const row = info.row;
          const val = info.getValue();
          const cellId = `${row.index}:front_html`;
          return (
            <EditableCell
              value={val}
              cellId={cellId}
              onSave={(newVal) => handleCellSave(row.original.id, { front_html: newVal })}
              onSelect={handleCellSelect}
              onNavigate={(dir) => handleCellNavigate(row.index, 'front_html', dir)}
              multiline
              renderDisplay={(v) => (
                <div
                  className="text-sm leading-relaxed text-gray-800"
                  dangerouslySetInnerHTML={{
                    __html: showAnkiFormat ? renderClozeHtml(v) : v,
                  }}
                />
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
          return (
            <TagsCell
              tags={info.getValue()}
              cellId={cellId}
              onSave={(newTags) => handleCellSave(row.original.id, { tags: newTags })}
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
        size: 80,
        cell: (info) => {
          const val = info.getValue();
          return val ? (
            <img src={val} alt="ref" className="max-h-12 rounded" />
          ) : (
            <span className="text-gray-300 text-xs">—</span>
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
        size: 88,
        enableResizing: false,
        header: () => null,
        cell: ({ row }) => {
          const card = row.original;
          const isRejected = card.status === 'rejected';
          return (
            <div className="flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity duration-100">
              <button
                onClick={() => {
                  setEditingId(card.id);
                  setEditFrontHtml(card.front_html);
                  setEditTags(card.tags.join(', '));
                  setViewMode('cards');
                }}
                className="p-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50"
                title="Edit in card view"
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
            </div>
          );
        },
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredCards.length, selectedIds, handleCellSelect, handleCellNavigate, handleCellSave, showAnkiFormat, sectionId, topicPath, onReviewChange, fetchCards]
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
      else if (topicTreeId) params.topic_tree_id = topicTreeId;
      const est = await estimateCost(params);
      setEstimate(est);
    } catch {
      setJobError('Estimate failed');
    } finally {
      setEstimating(false);
    }
  }, [selectedRuleSetId, selectedModel, sectionId, topicTreeId]);

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
      else if (topicTreeId) params.topic_tree_id = topicTreeId;
      const { job_id } = await startGeneration(params);

      intervalRef.current = setInterval(async () => {
        try {
          const job = await getGenerationJob(job_id);
          setJobProgress({ processed: job.processed_sections, total: job.total_sections });
          if (job.status === 'done' || job.status === 'failed') {
            if (intervalRef.current) clearInterval(intervalRef.current);
            setJobRunning(false);
            if (job.status === 'failed') {
              setJobAlertError(job.error_message ?? 'Generation failed');
            }
            fetchCards(sectionId, topicPath);
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
  }, [selectedRuleSetId, selectedModel, sectionId, topicTreeId, topicPath, fetchCards, onReviewChange, refreshUsage]);

  // Resume polling for active jobs on mount (after page refresh)
  useEffect(() => {
    if (jobRunning) return;
    getActiveJobs().then((jobs) => {
      const relevant = jobs.find(j =>
        (sectionId && j.section_id === sectionId) ||
        (topicTreeId && j.topic_tree_id === topicTreeId) ||
        (!sectionId && !topicTreeId)
      );
      if (!relevant) return;
      setJobRunning(true);
      setJobProgress({ processed: relevant.processed_sections, total: relevant.total_sections });
      intervalRef.current = setInterval(async () => {
        try {
          const job = await getGenerationJob(relevant.id);
          setJobProgress({ processed: job.processed_sections, total: job.total_sections });
          if (job.status === 'done' || job.status === 'failed') {
            if (intervalRef.current) clearInterval(intervalRef.current);
            setJobRunning(false);
            if (job.status === 'failed') {
              setJobAlertError(job.error_message ?? 'Generation failed');
            }
            fetchCards(sectionId, topicPath);
            onReviewChange?.();
            refreshUsage?.();
          }
        } catch {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setJobRunning(false);
        }
      }, 1500);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    setEditTags(card.tags.join(', '));
  }, []);

  const handleSaveEdit = useCallback(async (id: number) => {
    try {
      const tags = editTags.split(',').map((t) => t.trim()).filter(Boolean);
      await updateCard(id, { front_html: editFrontHtml, tags });
      setEditingId(null);
      fetchCards(sectionId, topicPath, true);
    } catch {
      setActionError('Save failed');
    }
  }, [editFrontHtml, editTags, fetchCards, sectionId, topicPath]);

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

  // ── Bulk actions ─────────────────────────────────────────────────────────

  const handleBulkReview = useCallback(async () => {
    if (selectedIds.size === 0) return;
    try {
      await bulkMarkReviewed([...selectedIds]);
      setSelectedIds(new Set());
      fetchCards(sectionId, topicPath, true);
      onReviewChange?.();
    } catch {
      setActionError('Bulk review failed');
    }
  }, [selectedIds, fetchCards, sectionId, topicPath, onReviewChange]);

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    try {
      await bulkDeleteCards([...selectedIds]);
      setSelectedIds(new Set());
      fetchCards(sectionId, topicPath, true);
      onReviewChange?.();
    } catch {
      setActionError('Bulk delete failed');
    }
  }, [selectedIds, fetchCards, sectionId, topicPath, onReviewChange]);

  const handleGenSupplemental = useCallback(async () => {
    if (selectedIds.size === 0 || !selectedRuleSetId || !selectedModel) return;
    try {
      const { job_id } = await startSupplemental({
        card_ids: [...selectedIds],
        rule_set_id: selectedRuleSetId,
        model: selectedModel,
      });
      setJobRunning(true);
      setJobProgress(null);
      intervalRef.current = setInterval(async () => {
        try {
          const job = await getGenerationJob(job_id);
          setJobProgress({ processed: job.processed_sections, total: job.total_sections });
          if (job.status === 'done' || job.status === 'failed') {
            if (intervalRef.current) clearInterval(intervalRef.current);
            setJobRunning(false);
            if (job.status === 'failed') {
              setJobAlertError(job.error_message ?? 'Supplemental generation failed');
            }
            fetchCards(sectionId, topicPath, true);
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
  }, [selectedIds, selectedRuleSetId, selectedModel, fetchCards, sectionId, topicPath, refreshUsage]);

  // ── Empty state ──────────────────────────────────────────────────────────

  const hasContext = sectionId != null || topicPath != null;

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
  const exportUrl = topicTreeId ? exportCardsUrl({ topic_tree_id: topicTreeId }) : undefined;

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

        {/* Export */}
        {exportUrl && (
          <a
            href={exportUrl}
            className="px-2.5 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
          >
            Export CSV
          </a>
        )}
      </div>

      {/* Selection action bar — only shown when cards are selected */}
      {selectedIds.size > 0 && (
        <div className="shrink-0 bg-blue-50 border-b border-blue-200 px-4 py-1.5 flex items-center gap-2">
          <span className="text-xs text-blue-700 font-semibold">{selectedIds.size} selected</span>
          <div className="w-px h-4 bg-blue-200" />
          <button
            onClick={() => setAnkifyOpen(true)}
            className="px-2.5 py-1 text-xs font-medium text-violet-700 bg-violet-50 border border-violet-200 rounded-lg hover:bg-violet-100 transition-colors duration-150"
          >
            Ankify
          </button>
          <button
            onClick={handleBulkReview}
            className="px-2.5 py-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors duration-150"
          >
            Mark Reviewed
          </button>
          <button
            onClick={handleGenSupplemental}
            disabled={jobRunning || !selectedRuleSetId}
            className="px-2.5 py-1 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 disabled:opacity-50 transition-colors duration-150"
            title="Generate vignette + teaching case for selected cards (grouped by condition)"
          >
            Gen Vignettes &amp; Cases
          </button>
          <button
            onClick={handleBulkDelete}
            className="px-2.5 py-1 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors duration-150"
          >
            Delete
          </button>
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

      {/* Generation controls */}
      {sectionId != null && (
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
              />
            ))}
          </div>
        ) : (
          // Table view — Excel-like grid
          <div ref={tableContainerRef} className="overflow-auto">
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
                          padding: ['select', 'card_number', 'status', 'row_actions'].includes(cell.column.id) ? '6px 8px' : '6px 10px',
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
    </div>
  );
}
