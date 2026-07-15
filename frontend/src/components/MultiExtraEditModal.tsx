import { useEffect, useState } from 'react';
import type { Card } from '../types';
import { renderClozeHtml } from '../pages/CardsPanel';

interface MultiExtraEditModalProps {
  cards: Card[];
  activeVersion: 'base' | 'v1' | 'v2' | 'v3';
  initialExtras: Record<number, string>;
  onSaveAll: (extras: Record<number, string>) => void | Promise<void>;
  onClose: () => void;
}

type DisplayMode = 'extra-only' | 'front-and-extra';

export default function MultiExtraEditModal({
  cards,
  activeVersion,
  initialExtras,
  onSaveAll,
  onClose,
}: MultiExtraEditModalProps) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>('extra-only');
  const [extras, setExtras] = useState<Record<number, string>>(() => ({ ...initialExtras }));

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
    await onSaveAll(extras);
    onClose();
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

              {/* Extra textarea */}
              <div className="p-2 bg-white">
                <textarea
                  value={extras[card.id] ?? ''}
                  onChange={(e) => setExtras((prev) => ({ ...prev, [card.id]: e.target.value }))}
                  rows={5}
                  className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2 resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono leading-relaxed text-gray-700"
                  placeholder="Extra / additional context…"
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
            className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >
            Save all
          </button>
        </div>
      </div>
    </div>
  );
}
