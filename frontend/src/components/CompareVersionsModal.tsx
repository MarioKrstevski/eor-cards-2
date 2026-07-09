import { useEffect, useMemo, useState } from 'react';
import type { Card } from '../types';
import { getCards, apiErrorMessage } from '../api';

/**
 * Full-screen side-by-side comparison of card versions. Each row is one card;
 * each chosen version (base / v1 / v2 / v3) is a column — so you can see how the
 * same card came out across different models/approaches and pick the best.
 *
 * Fetches the WHOLE card set for the scope (all rows, every version, no version
 * filter) — NOT the version-filtered/paginated table view — so a version that
 * made more cards than base still shows its extra rows, with blanks where
 * another version has no card at that position.
 */
interface Props {
  scope: { sectionId?: number | null; topicPath?: string | null; sectionIds?: number[] | null };
  onClose: () => void;
}

const ALL_VERSIONS = ['base', 'v1', 'v2', 'v3'] as const;
type Ver = typeof ALL_VERSIONS[number];

function frontFor(card: Card, ver: Ver): string {
  if (ver === 'base') return card.front_html || '';
  return (card as unknown as Record<string, string>)[`front_html_${ver}`] || '';
}
function extraFor(card: Card, ver: Ver): string {
  if (ver === 'base') return card.extra || '';
  return (card as unknown as Record<string, string>)[`extra_${ver}`] || '';
}

// Show clozes as blue-bold terms so the card reads naturally for comparison.
function reveal(html: string): string {
  return (html || '')
    .replace(/(?:<b>)?<span[^>]*>\{\{c\d+::([^}]+)\}\}<\/span>(?:<\/b>)?/g, '<span style="color:#1f77b4;font-weight:700">$1</span>')
    .replace(/\{\{c\d+::([^}]+)\}\}/g, '<span style="color:#1f77b4;font-weight:700">$1</span>');
}

export default function CompareVersionsModal({ scope, onClose }: Props) {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch every active card in scope, all versions (no version filter), so the
  // grid can show the full union across versions with blanks where a version
  // has fewer cards than another.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params: Parameters<typeof getCards>[0] = { limit: 1000, offset: 0, status: 'active' };
        if (scope.sectionId != null) params.section_id = scope.sectionId;
        else if (scope.sectionIds && scope.sectionIds.length > 0) params.section_ids = scope.sectionIds.join(',');
        else if (scope.topicPath) params.topic = scope.topicPath;
        const resp = await getCards(params);
        if (!cancelled) setCards(resp.cards);
      } catch (e) {
        if (!cancelled) setError(apiErrorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scope.sectionId, scope.topicPath, scope.sectionIds]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Default to the versions that actually have content somewhere in the deck.
  const populated = useMemo(() => {
    const has: Record<Ver, boolean> = { base: false, v1: false, v2: false, v3: false };
    for (const c of cards) for (const v of ALL_VERSIONS) if (frontFor(c, v).trim()) has[v] = true;
    return has;
  }, [cards]);
  const [selected, setSelected] = useState<Ver[]>(['base']);
  // Once cards load, expand the default selection to every populated version.
  useEffect(() => {
    setSelected(ALL_VERSIONS.filter((v) => (v === 'base' ? true : populated[v])));
  }, [populated]);

  const toggle = (v: Ver) =>
    setSelected((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...ALL_VERSIONS].filter((x) => s.includes(x) || x === v)));

  const cols = selected.length || 1;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-100">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 bg-white border-b border-gray-200 shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="text-sm font-bold text-gray-900">Compare versions</h2>
          <div className="flex items-center gap-2">
            {ALL_VERSIONS.map((v) => (
              <label key={v} className={`flex items-center gap-1 text-xs px-2 py-1 rounded-lg border cursor-pointer ${selected.includes(v) ? 'bg-blue-50 text-blue-700 border-blue-300' : 'bg-white text-gray-500 border-gray-200'}`}>
                <input type="checkbox" checked={selected.includes(v)} onChange={() => toggle(v)} className="accent-blue-600" />
                {v === 'base' ? 'Current' : v}
                {v !== 'base' && !populated[v] && <span className="text-gray-300">(empty)</span>}
              </label>
            ))}
          </div>
          <span className="text-xs text-gray-400">{cards.length} card(s)</span>
        </div>
        <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg" title="Close (Esc)">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      {/* Column headers (sticky) */}
      <div className="shrink-0 bg-gray-50 border-b border-gray-200 px-4 py-2"
        style={{ display: 'grid', gridTemplateColumns: `40px repeat(${cols}, 1fr)`, gap: '12px' }}>
        <div />
        {selected.map((v) => (
          <div key={v} className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{v === 'base' ? 'Current (base)' : v}</div>
        ))}
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-auto px-4 py-3">
        {loading && <p className="text-sm text-gray-400 text-center py-10">Loading all versions…</p>}
        {error && <p className="text-sm text-red-500 text-center py-10">{error}</p>}
        {!loading && !error && cards.map((c, i) => (
          <div key={c.id} className="border-b border-gray-100 py-3"
            style={{ display: 'grid', gridTemplateColumns: `40px repeat(${cols}, 1fr)`, gap: '12px' }}>
            <div className="text-xs text-gray-400 tabular-nums pt-1">{i + 1}</div>
            {selected.map((v) => {
              const front = frontFor(c, v);
              const extra = extraFor(c, v);
              return (
                <div key={v} className="bg-white rounded-lg border border-gray-200 p-3 min-w-0">
                  {front.trim() ? (
                    <>
                      <div className="text-sm text-gray-800 leading-relaxed break-words" dangerouslySetInnerHTML={{ __html: reveal(front) }} />
                      {extra.trim() && (
                        <div className="mt-2 pt-2 border-t border-gray-100 text-xs text-gray-500 leading-relaxed break-words" dangerouslySetInnerHTML={{ __html: reveal(extra) }} />
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-gray-300">—</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {!loading && !error && cards.length === 0 && <p className="text-sm text-gray-400 text-center py-10">No cards to compare.</p>}
      </div>
    </div>
  );
}
