import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { getPresentationCards } from '../api';
import type { Card, Presentation } from '../types';

// ── Cloze rendering ────────────────────────────────────────────────────────────
function renderHidden(html: string): string {
  let result = html.replace(
    /(?:<b>)?<span[^>]*>\{\{c\d+::([^}]+)\}\}<\/span>(?:<\/b>)?/g,
    '<span style="display:inline-block;background:#e2e8f0;border-radius:4px;padding:1px 10px;color:#94a3b8;font-weight:600;border-bottom:2px solid #94a3b8;font-size:0.9em">[...]</span>'
  );
  result = result.replace(
    /\{\{c\d+::([^}]+)\}\}/g,
    '<span style="display:inline-block;background:#e2e8f0;border-radius:4px;padding:1px 10px;color:#94a3b8;font-weight:600;border-bottom:2px solid #94a3b8;font-size:0.9em">[...]</span>'
  );
  return result;
}

function renderRevealed(html: string): string {
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

const RATINGS = [
  { label: 'Again', time: '<1m', color: 'hover:bg-red-50 hover:border-red-300 hover:text-red-700', key: '1' },
  { label: 'Hard',  time: '<6m', color: 'hover:bg-orange-50 hover:border-orange-300 hover:text-orange-700', key: '2' },
  { label: 'Good',  time: '<10m', color: 'hover:bg-green-50 hover:border-green-300 hover:text-green-700', key: '3' },
  { label: 'Easy',  time: '8d',  color: 'hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700', key: '4' },
];

function CollapsibleSection({ title, html }: { title: string; html: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center justify-between w-full px-5 py-3 text-left hover:bg-gray-50 transition-colors duration-150"
      >
        <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{title}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className={`h-4 w-4 text-gray-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="px-5 pb-4 text-sm text-gray-700 leading-relaxed border-t border-gray-100" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

function DoneScreen({ presentation, total, onRestart }: { presentation: Presentation; total: number; onRestart: () => void }) {
  return (
    <div className="fixed inset-0 bg-gray-100 flex flex-col items-center justify-center gap-6">
      <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center">
        <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <div className="text-center">
        <h1 className="text-xl font-bold text-gray-900 mb-1">{presentation.name}</h1>
        <p className="text-sm text-gray-500">{total} card{total !== 1 ? 's' : ''} completed</p>
      </div>
      <button
        onClick={onRestart}
        className="px-6 py-2 bg-blue-700 text-white text-sm font-medium rounded-xl hover:bg-blue-800 transition-colors duration-150"
      >
        Start Over
      </button>
    </div>
  );
}

export default function AnkiPlayerPage() {
  const { slug } = useParams<{ slug: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!slug) return;
    getPresentationCards(slug)
      .then(({ presentation: p, cards: c }) => {
        setPresentation(p);
        setCards(c);
      })
      .catch(() => setError('Presentation not found.'))
      .finally(() => setLoading(false));
  }, [slug]);

  const advance = useCallback(() => {
    if (index >= cards.length - 1) {
      setDone(true);
    } else {
      setIndex(i => i + 1);
      setRevealed(false);
    }
  }, [index, cards.length]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).matches('input, textarea')) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (!revealed) setRevealed(true);
        else advance();
        return;
      }
      if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
        advance();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [revealed, advance]);

  if (loading) {
    return (
      <div className="fixed inset-0 bg-gray-100 flex items-center justify-center">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  if (error || !presentation) {
    return (
      <div className="fixed inset-0 bg-gray-100 flex items-center justify-center">
        <p className="text-sm text-red-500">{error || 'Presentation not found.'}</p>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="fixed inset-0 bg-gray-100 flex flex-col items-center justify-center gap-3">
        <h1 className="text-lg font-bold text-gray-900">{presentation.name}</h1>
        <p className="text-sm text-gray-500">No cards available for this presentation.</p>
        {presentation.card_version !== 'base' && (
          <p className="text-xs text-gray-400">Version {presentation.card_version.toUpperCase()} has not been generated for these cards yet.</p>
        )}
      </div>
    );
  }

  if (done) {
    return (
      <DoneScreen
        presentation={presentation}
        total={cards.length}
        onRestart={() => { setIndex(0); setRevealed(false); setDone(false); }}
      />
    );
  }

  const card = cards[index];
  const progress = (index / cards.length) * 100;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-100">
      {/* Progress bar */}
      <div className="h-1 bg-gray-200 shrink-0">
        <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progress}%` }} />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 bg-white border-b border-gray-200 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-gray-700 truncate max-w-xs">{presentation.name}</span>
          {presentation.card_version !== 'base' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 font-semibold uppercase">
              {presentation.card_version}
            </span>
          )}
          <span className="text-sm font-medium text-gray-400 tabular-nums">
            {index + 1} <span className="text-gray-300">/</span> {cards.length}
          </span>
        </div>
        {card.topic_path && (
          <span className="text-xs text-gray-400 truncate max-w-xs hidden sm:block">{card.topic_path}</span>
        )}
      </div>

      {/* Card area */}
      <div className="flex-1 overflow-y-auto px-6 pt-8 pb-4">
        <div className="w-full max-w-2xl mx-auto">
          <div className="bg-white rounded-2xl shadow-md border border-gray-200 p-8">
            {card.ref_img && card.ref_img_position === 'front' && (
              <img src={card.ref_img} alt="Reference" className="max-h-48 mx-auto rounded mb-4" />
            )}
            <div
              className="text-base leading-relaxed text-gray-800"
              dangerouslySetInnerHTML={{
                __html: revealed ? renderRevealed(card.front_html) : renderHidden(card.front_html),
              }}
            />
          </div>

          {revealed && card.extra && (
            <div className="mt-4 bg-white rounded-xl border border-gray-200 px-5 py-3.5">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Additional context</p>
              <div className="text-sm text-gray-600 leading-relaxed" dangerouslySetInnerHTML={{ __html: card.extra }} />
            </div>
          )}

          {revealed && card.ref_img && card.ref_img_position === 'back' && (
            <img src={card.ref_img} alt="Reference" className="max-h-48 mx-auto rounded mb-4 mt-3" />
          )}

          {revealed && card.vignette && <CollapsibleSection title="Vignette" html={card.vignette} />}
          {revealed && card.teaching_case && <CollapsibleSection title="Teaching Case" html={card.teaching_case} />}
        </div>
      </div>

      {/* Action bar */}
      <div className="shrink-0 bg-white border-t border-gray-200 px-6 py-4">
        <div className="w-full max-w-2xl mx-auto">
          {!revealed ? (
            <div className="flex flex-col items-center gap-1.5">
              <button
                onClick={() => setRevealed(true)}
                className="px-8 py-2 bg-white border border-gray-300 rounded-full text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-400 transition-colors duration-150 shadow-sm"
              >
                Show Answer
              </button>
              <span className="text-[10px] text-gray-400">or press Space</span>
            </div>
          ) : (
            <div>
              <div className="grid grid-cols-4 gap-2">
                {RATINGS.map((r) => (
                  <button
                    key={r.key}
                    onClick={advance}
                    className={`flex flex-col items-center gap-0.5 py-2 px-2 bg-white border border-gray-200 rounded-lg transition-colors duration-150 shadow-sm ${r.color}`}
                  >
                    <span className="text-[10px] text-gray-400 font-medium">{r.time}</span>
                    <span className="text-sm font-semibold text-gray-700">{r.label}</span>
                    <span className="text-[10px] text-gray-300 font-mono">{r.key}</span>
                  </button>
                ))}
              </div>
              <p className="text-center text-[10px] text-gray-400 mt-2">Space or 1–4 to continue</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
