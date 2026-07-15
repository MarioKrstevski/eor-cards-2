import { useEffect } from 'react';

interface MultiCardEditPopupProps {
  count: number;
  onCombine: () => void;
  onRebuildFooters: () => void;
  onEditExtras: () => void;
  onDelete?: () => void;
  onClose: () => void;
}

// Docked right-side panel shown when 2+ cards are selected — the multi-card
// counterpart to CardEditPopup. Same chrome (fixed right-4 top-24 w-80 z-40,
// white/rounded/border/shadow, Esc-to-close). Buttons call handlers that live in
// CardsPanel: doRegenWithMode('combine') and handleRebuildFooters.
export default function MultiCardEditPopup({ count, onCombine, onRebuildFooters, onEditExtras, onDelete, onClose }: MultiCardEditPopupProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed right-4 top-24 w-80 z-40 bg-white rounded-xl border border-gray-200 shadow-2xl flex flex-col max-h-[calc(100vh-8rem)]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200">
        <span className="text-xs font-semibold text-gray-900">{count} cards selected</span>
        <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-50" title="Close (Esc)">✕</button>
      </div>

      <div className="p-3 flex flex-col gap-2.5 overflow-auto">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Multi-card edits</p>

        <button
          onClick={onCombine}
          title="Combine the selected cards into one"
          className="px-2.5 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
        >
          Combine into one
        </button>

        <button
          onClick={onRebuildFooters}
          title="Set each selected card's Extra to a bulleted list of the other selected cards"
          className="flex flex-col items-start gap-0.5 px-2.5 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
        >
          <span>Rebuild sibling footers</span>
          <span className="text-[10px] font-normal text-gray-500">Fill each card's footer with the others</span>
        </button>

        <button
          onClick={onEditExtras}
          title="Edit the Extra field for each selected card in one place"
          className="flex flex-col items-start gap-0.5 px-2.5 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
        >
          <span>Edit extras</span>
          <span className="text-[10px] font-normal text-gray-500">Edit all selected cards' extra fields</span>
        </button>

        {onDelete && (
          <button
            onClick={onDelete}
            title={`Delete ${count} selected cards`}
            className="px-2.5 py-1.5 text-xs font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors duration-150"
          >
            Delete {count} cards
          </button>
        )}
      </div>
    </div>
  );
}
