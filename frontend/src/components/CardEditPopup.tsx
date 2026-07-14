import { useEffect, useRef, useState } from 'react';
import type { Card } from '../types';
import { useSettings } from '../context/SettingsContext';
import { rewordSnippet } from '../api';
import { renderClozeHtml } from '../pages/CardsPanel';

type CardVersion = 'base' | 'v1' | 'v2' | 'v3';

// Read the front HTML for the active version. Each version is independent — no
// base fallback (matches getFieldValue in CardsPanel).
function frontFor(card: Card, ver: CardVersion): string {
  if (ver === 'v1') return card.front_html_v1 ?? '';
  if (ver === 'v2') return card.front_html_v2 ?? '';
  if (ver === 'v3') return card.front_html_v3 ?? '';
  return card.front_html ?? '';
}

// Reduce a front to readable plain text: drop HTML tags AND cloze wrappers,
// leaving just the terms. Used as the `text` context sent to the reword API.
function frontToPlainText(html: string): string {
  return html
    .replace(/\{\{c\d+::([^}]*?)(?:::[^}]*)?\}\}/g, '$1') // cloze → inner term (drop ::hint)
    .replace(/<[^>]+>/g, '') // strip tags
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

export default function CardEditPopup({ card, onSave, onRegenerate, onClose }: CardEditPopupProps) {
  const { activeCardVersion } = useSettings();
  const ver = activeCardVersion as CardVersion;
  const [front, setFront] = useState('');
  const [hasSelection, setHasSelection] = useState(false);
  const [rewording, setRewording] = useState(false);
  const [saved, setSaved] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Reload the draft when the target card or active version changes (never on
  // background refresh mid-edit — those don't change card.id/version).
  useEffect(() => {
    setFront(frontFor(card, ver));
    setHasSelection(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, ver]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function syncSelection() {
    const ta = taRef.current;
    if (!ta) return;
    setHasSelection(ta.selectionStart !== ta.selectionEnd);
  }

  async function handleReword() {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    if (s === e) return;
    const snippet = front.slice(s, e);
    setRewording(true);
    try {
      const { reworded } = await rewordSnippet(frontToPlainText(front), snippet);
      setFront(front.slice(0, s) + reworded + front.slice(e));
    } catch {
      /* leave the text untouched on failure */
    } finally {
      setRewording(false);
    }
  }

  function handleUnitsOut() {
    const ta = taRef.current;
    if (!ta) { setFront(unitsOut(front)); return; }
    const { selectionStart: s, selectionEnd: e } = ta;
    if (s !== e) {
      // Apply only within the selection.
      setFront(front.slice(0, s) + unitsOut(front.slice(s, e)) + front.slice(e));
    } else {
      setFront(unitsOut(front));
    }
  }

  async function handleSave() {
    await onSave(card.id, { [frontPatchKey(ver)]: front });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
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
        {/* Read-only Anki-rendered preview */}
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Preview</p>
          <div
            className="text-sm leading-relaxed text-gray-800 border border-gray-100 rounded-lg px-2.5 py-2 bg-gray-50/40 min-h-[2.5rem]"
            dangerouslySetInnerHTML={{ __html: renderClozeHtml(front) }}
          />
        </div>

        {/* Raw HTML editor (phase 1) */}
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Raw front</p>
          <textarea
            ref={taRef}
            value={front}
            onChange={(e) => setFront(e.target.value)}
            onSelect={syncSelection}
            onKeyUp={syncSelection}
            onMouseUp={syncSelection}
            className="w-full min-h-[120px] text-sm border border-gray-200 rounded-lg px-2.5 py-2 resize-y font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            spellCheck={false}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
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
            title="Move a trailing unit outside the cloze, e.g. {{c1::20 years}} → {{c1::20}} years. Applies to the selection if any, else the whole front."
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
