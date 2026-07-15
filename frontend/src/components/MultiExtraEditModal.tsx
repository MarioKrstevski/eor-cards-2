import { useEffect, useRef, useState } from 'react';
import type { Card } from '../types';
import { renderClozeHtml } from '../pages/CardsPanel';
import { toEditorHtml, applyBoldToRange } from './CardEditPopup';

interface MultiExtraEditModalProps {
  cards: Card[];
  activeVersion: 'base' | 'v1' | 'v2' | 'v3';
  initialExtras: Record<number, string>;
  onSaveAll: (extras: Record<number, string>) => void | Promise<void>;
  onClose: () => void;
}

type DisplayMode = 'extra-only' | 'front-and-extra';

// Walk the editor DOM and return stored HTML, PRESERVING <br> literals.
// Unlike fromEditorHtml (CardEditPopup), we do NOT convert <br> to \n, since
// extra footers rely on literal <br> for line-breaks.
//
// Rules:
//   .cz span      → <span style="color:#1f77b4"><b>{{c1::TERM[::HINT]}}</b></span>
//   <b>/<strong>  → <b>…</b>
//   <br>          → <br>  (PRESERVED — NOT converted to newline)
//   <div>/<p>     → prefix <br> (except the very first block child, to avoid
//                   a spurious leading <br>) + recurse inner content
//   text node     → textContent
//   other tags    → drop tag, keep inner text
function serializeExtraNode(node: ChildNode, isFirstBlock?: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  // Cloze span → stored cloze markup.
  if (el.classList.contains('cz')) {
    const term = el.textContent ?? '';
    const hint = el.getAttribute('data-hint') ?? '';
    const body = hint ? `${term}::${hint}` : term;
    return `<span style="color:#1f77b4"><b>{{c1::${body}}}</b></span>`;
  }

  // Recurse for inner content.
  let inner = '';
  el.childNodes.forEach((c) => { inner += serializeExtraNode(c); });

  // Non-cloze bold.
  if (tag === 'b' || tag === 'strong') {
    return `<b>${inner}</b>`;
  }

  // Hard line-break — PRESERVE as <br>.
  if (tag === 'br') return '<br>';

  // Block elements the browser inserts when the user presses Enter.
  // Prefix with <br> for all but the very first block child.
  if (tag === 'div' || tag === 'p') {
    const prefix = isFirstBlock ? '' : '<br>';
    return prefix + inner;
  }

  // Any other tag: drop the wrapper, keep inner content.
  return inner;
}

function serializeExtra(node: HTMLElement): string {
  let out = '';
  let blockIndex = 0;
  node.childNodes.forEach((child) => {
    const isBlock =
      child.nodeType === Node.ELEMENT_NODE &&
      ['div', 'p'].includes((child as HTMLElement).tagName.toLowerCase());
    out += serializeExtraNode(child, isBlock && blockIndex === 0);
    if (isBlock) blockIndex++;
  });
  return out;
}

export default function MultiExtraEditModal({
  cards,
  activeVersion,
  initialExtras,
  onSaveAll,
  onClose,
}: MultiExtraEditModalProps) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>('extra-only');

  // Per-card editor refs — DOM is the source of truth, no extras state needed.
  const editorRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function getFrontHtml(card: Card): string {
    if (activeVersion === 'v1') return card.front_html_v1 ?? card.front_html ?? '';
    if (activeVersion === 'v2') return card.front_html_v2 ?? card.front_html ?? '';
    if (activeVersion === 'v3') return card.front_html_v3 ?? card.front_html ?? '';
    return card.front_html ?? '';
  }

  async function handleSaveAll() {
    const map: Record<number, string> = {};
    for (const card of cards) {
      const el = editorRefs.current[card.id];
      map[card.id] = el ? serializeExtra(el) : (initialExtras[card.id] ?? '');
    }
    await onSaveAll(map);
    onClose();
  }

  // Bold the current selection inside a specific card's editor (reuses the
  // popup's tested bold core). Save-all serializes the mutated DOM.
  function handleBold(cardId: number) {
    const el = editorRefs.current[cardId];
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed || !el.contains(range.commonAncestorContainer)) return;
    applyBoldToRange(el, range);
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" role="dialog" aria-modal="true">
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div
        className="relative bg-white rounded-xl shadow-2xl border border-gray-200 flex flex-col"
        style={{ width: '760px', maxWidth: '94vw', maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 shrink-0">
          <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">
            Edit Extras — {cards.length} card{cards.length !== 1 ? 's' : ''}
            {activeVersion !== 'base' && (
              <span className="ml-2 px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 text-[9px] font-semibold normal-case">{activeVersion.toUpperCase()}</span>
            )}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-50"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Toggle */}
        <div className="shrink-0 px-4 py-2 border-b border-gray-100 flex items-center gap-2">
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Show</span>
          <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
            <button
              onClick={() => setDisplayMode('extra-only')}
              className={`px-3 py-1 text-xs font-medium transition-colors duration-150 ${displayMode === 'extra-only' ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              Extra only
            </button>
            <button
              onClick={() => setDisplayMode('front-and-extra')}
              className={`px-3 py-1 text-xs font-medium transition-colors duration-150 ${displayMode === 'front-and-extra' ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              Front + Extra
            </button>
          </div>
        </div>

        {/* Scrollable card list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {cards.map((card) => (
            <div key={card.id} className="border border-gray-200 rounded-lg overflow-hidden">
              {/* Card label */}
              <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                <span className="text-[11px] font-semibold text-gray-500">#{card.card_number}</span>
              </div>

              {/* Front (conditionally shown) */}
              {displayMode === 'front-and-extra' && (
                <div
                  className="px-3 py-2 text-sm leading-relaxed text-gray-800 border-b border-gray-100 bg-white"
                  dangerouslySetInnerHTML={{ __html: renderClozeHtml(getFrontHtml(card)) }}
                />
              )}

              {/* Rendered Anki extra editor — contentEditable replaces the old textarea */}
              <div className="p-2 bg-white">
                <div className="mb-1.5">
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleBold(card.id)}
                    title="Bold the selected text"
                    className="px-2.5 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
                  >
                    Bold
                  </button>
                </div>
                <div
                  ref={(el) => {
                    editorRefs.current[card.id] = el;
                    // Initialize innerHTML on first mount. The check for innerHTML === ''
                    // prevents re-initializing while the user is typing (React may call
                    // the ref callback again on re-renders if displayMode changes).
                    if (el && el.innerHTML === '') {
                      el.innerHTML = toEditorHtml(initialExtras[card.id] ?? '');
                    }
                  }}
                  contentEditable
                  suppressContentEditableWarning
                  spellCheck={false}
                  className="w-full min-h-[120px] text-base leading-relaxed text-gray-800 border border-gray-200 rounded-lg px-3.5 py-3 whitespace-pre-wrap focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-end gap-2 px-4 py-2.5 border-t border-gray-200 bg-gray-50/60">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium text-gray-600 rounded-lg hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={handleSaveAll}
            className="px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded-lg hover:bg-green-700"
          >
            Save all
          </button>
        </div>
      </div>
    </div>
  );
}
