/**
 * AdminPage — hidden /admin lab dashboard.
 *
 * Self-gated: renders a plain "Not found" unless localStorage.getItem('lab') === '1'.
 * Enable in the browser console with: localStorage.setItem('lab', '1'); location.reload()
 */
import { useEffect, useState } from 'react';
import {
  getLabSections,
  getLabSection,
  startFinalization,
  type LabFinalizationSummary,
  type LabSectionDetail,
  type LabEditEvent,
} from '../api';

// ── Label maps ────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = {
  origin_generated: 'Generated',
  origin_manual: 'Manually added',
  origin_split: 'Split',
  origin_combine: 'Combined',
  bold: 'Bold',
  unbold: 'Unbold',
  cloze: 'Cloze',
  uncloze: 'Uncloze',
  units_out: 'Units out',
  clean: 'Clean',
  reword: 'Reword',
  guided_reword: 'Guided reword',
  regenerate: 'Regenerate',
  typed: 'Typed edit',
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

// ── Relative time ─────────────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'done'
      ? 'bg-green-100 text-green-800 border-green-300'
      : status === 'running'
        ? 'bg-blue-100 text-blue-800 border-blue-300'
        : 'bg-yellow-50 text-yellow-800 border-yellow-300';
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-semibold border ${cls}`}>
      {status}
    </span>
  );
}

// ── Section detail panel ──────────────────────────────────────────────────────

function SectionDetail({ sectionId, onClose }: { sectionId: number; onClose: () => void }) {
  const [detail, setDetail] = useState<LabSectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    getLabSection(sectionId)
      .then(setDetail)
      .catch(() => setErr('Failed to load section detail'))
      .finally(() => setLoading(false));
  }, [sectionId]);

  if (loading) return <p className="text-sm text-gray-500 py-4">Loading…</p>;
  if (err) return <p className="text-sm text-red-600 py-4">{err}</p>;
  if (!detail) return null;

  const { latest_snapshot, events_by_card, latest_finalization, section_heading } = detail;

  // Aggregate action-type counts across all cards
  const kindCounts: Record<string, number> = {};
  for (const events of Object.values(events_by_card)) {
    for (const ev of events) {
      kindCounts[ev.kind] = (kindCounts[ev.kind] ?? 0) + 1;
    }
  }
  const totalEvents = Object.values(kindCounts).reduce((a, b) => a + b, 0);

  return (
    <div className="border border-gray-200 rounded-lg bg-white mt-2 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
        <h3 className="text-sm font-semibold text-gray-800">{section_heading ?? `Section ${sectionId}`}</h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700 text-xs px-2 py-1 rounded hover:bg-gray-100"
        >
          Close ✕
        </button>
      </div>

      <div className="p-4 space-y-6">

        {/* Generation Snapshot */}
        <section>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Initial Generation Snapshot</h4>
          {!latest_snapshot ? (
            <p className="text-xs text-gray-400">No snapshot recorded for this section.</p>
          ) : (
            <div className="space-y-1 text-xs text-gray-700">
              <p><span className="font-medium text-gray-500">Model:</span> {latest_snapshot.model ?? '—'}</p>
              <p><span className="font-medium text-gray-500">Rule set ID:</span> {latest_snapshot.rule_set_id ?? '—'}</p>
              <p><span className="font-medium text-gray-500">Card version:</span> {latest_snapshot.card_version ?? '—'}</p>
              <p><span className="font-medium text-gray-500">Generated:</span> {fmtDate(latest_snapshot.created_at)}</p>
              {latest_snapshot.cards_json && latest_snapshot.cards_json.length > 0 && (
                <div className="mt-2">
                  <p className="font-medium text-gray-500 mb-1">Cards ({latest_snapshot.cards_json.length}):</p>
                  <div className="space-y-1 max-h-60 overflow-y-auto border border-gray-100 rounded p-2 bg-gray-50">
                    {latest_snapshot.cards_json.map((c) => (
                      <div key={c.card_id} className="text-[11px] text-gray-700 border-b border-gray-100 pb-1 last:border-0 last:pb-0">
                        <span className="text-gray-400 font-mono mr-1">#{c.card_number}</span>
                        {c.front_html}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Action-type counts */}
        <section>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Edit Action Summary ({totalEvents} total events)
          </h4>
          {totalEvents === 0 ? (
            <p className="text-xs text-gray-400">No edit events recorded.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {Object.entries(kindCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([kind, count]) => (
                  <span
                    key={kind}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-gray-100 text-gray-700 border border-gray-200"
                  >
                    <span className="font-medium">{kindLabel(kind)}</span>
                    <span className="text-gray-400">×{count}</span>
                  </span>
                ))}
            </div>
          )}
        </section>

        {/* Per-card timeline */}
        <section>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Per-Card Edit Timeline</h4>
          {Object.keys(events_by_card).length === 0 ? (
            <p className="text-xs text-gray-400">No edit events recorded for any card in this section.</p>
          ) : (
            <div className="space-y-4 max-h-[480px] overflow-y-auto">
              {Object.entries(events_by_card).map(([cardIdStr, events]) => (
                <div key={cardIdStr} className="border border-gray-200 rounded p-2">
                  <p className="text-[11px] font-semibold text-gray-500 mb-1.5">Card ID {cardIdStr}</p>
                  <div className="space-y-1">
                    {events.map((ev: LabEditEvent, idx) => (
                      <div key={idx} className="flex items-start gap-2 text-[11px]">
                        <span className="shrink-0 w-5 text-right text-gray-300 font-mono">{ev.seq}</span>
                        <span className="shrink-0 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100 font-medium">
                          {kindLabel(ev.kind)}
                        </span>
                        {ev.field && (
                          <span className="shrink-0 text-gray-400">[{ev.field}]</span>
                        )}
                        <span className="shrink-0 text-gray-300">{relativeTime(ev.created_at)}</span>
                        {ev.front_html && (
                          <span className="text-gray-700 truncate max-w-xs" title={ev.front_html}>
                            {ev.front_html}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Finalization */}
        <section>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Finalization (Final Cards)</h4>
          {!latest_finalization ? (
            <p className="text-xs text-gray-400">No finalization yet.</p>
          ) : (
            <div className="space-y-1 text-xs text-gray-700">
              <p><span className="font-medium text-gray-500">Status:</span> <StatusBadge status={latest_finalization.loop_status} /></p>
              <p><span className="font-medium text-gray-500">Finalized:</span> {fmtDate(latest_finalization.created_at)}</p>
              {latest_finalization.finished_at && (
                <p><span className="font-medium text-gray-500">Finished:</span> {fmtDate(latest_finalization.finished_at)}</p>
              )}
              {latest_finalization.cards_json && latest_finalization.cards_json.length > 0 && (
                <div className="mt-2">
                  <p className="font-medium text-gray-500 mb-1">Final cards ({latest_finalization.cards_json.length}):</p>
                  <div className="space-y-1 max-h-60 overflow-y-auto border border-gray-100 rounded p-2 bg-gray-50">
                    {latest_finalization.cards_json.map((c) => (
                      <div key={c.card_id} className="text-[11px] text-gray-700 border-b border-gray-100 pb-1 last:border-0 last:pb-0">
                        <span className="text-gray-400 font-mono mr-1">#{c.card_number}</span>
                        {c.front_html}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ── Main AdminPage ─────────────────────────────────────────────────────────────

export default function AdminPage() {
  // Self-gate: only render if localStorage flag is set
  const isEnabled = typeof window !== 'undefined' && localStorage.getItem('lab') === '1';

  const [sections, setSections] = useState<LabFinalizationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expandedSectionId, setExpandedSectionId] = useState<number | null>(null);
  const [startingId, setStartingId] = useState<number | null>(null);

  const load = () => {
    if (!isEnabled) return;
    setLoading(true);
    setErr(null);
    getLabSections()
      .then(setSections)
      .catch(() => setErr('Failed to load lab sections'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEnabled]);

  if (!isEnabled) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-gray-400">Not found</p>
      </div>
    );
  }

  const handleStart = async (fin: LabFinalizationSummary) => {
    if (fin.loop_status !== 'pending') return;
    setStartingId(fin.id);
    try {
      await startFinalization(fin.id);
      load();
    } catch {
      // ignore
    } finally {
      setStartingId(null);
    }
  };

  const handleRowClick = (sectionId: number) => {
    setExpandedSectionId((prev) => (prev === sectionId ? null : sectionId));
  };

  return (
    <div className="flex flex-col h-full overflow-auto bg-gray-50">
      <div className="max-w-5xl mx-auto w-full px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-base font-bold text-gray-900">Lab Dashboard</h1>
            <p className="text-xs text-gray-400 mt-0.5">Edit-capture history · Section finalizations · Tuning loop (scaffold)</p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 bg-white rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>

        {err && <p className="text-sm text-red-600 mb-4">{err}</p>}

        {!loading && sections.length === 0 && (
          <p className="text-sm text-gray-400">No finalized sections yet. Use "Mark Section Done" from the card panel to create one.</p>
        )}

        {sections.length > 0 && (
          <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Section</th>
                  <th className="text-center px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Cards</th>
                  <th className="text-center px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Finalized</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sections.map((fin) => (
                  <>
                    <tr
                      key={fin.id}
                      className="hover:bg-gray-50 cursor-pointer"
                      onClick={() => handleRowClick(fin.section_id)}
                    >
                      <td className="px-4 py-2.5 text-gray-800 font-medium">
                        {fin.section_heading ?? `Section ${fin.section_id}`}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-600 tabular-nums">{fin.card_count}</td>
                      <td className="px-3 py-2.5 text-center">
                        <StatusBadge status={fin.loop_status} />
                      </td>
                      <td className="px-3 py-2.5 text-gray-400 text-xs">
                        {relativeTime(fin.created_at)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleStart(fin); }}
                          disabled={fin.loop_status !== 'pending' || startingId === fin.id}
                          className="px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          title={fin.loop_status !== 'pending' ? `Already ${fin.loop_status}` : 'Start the tuning loop for this section'}
                        >
                          {startingId === fin.id ? 'Starting…' : fin.loop_status === 'pending' ? 'Start' : fin.loop_status}
                        </button>
                      </td>
                    </tr>
                    {expandedSectionId === fin.section_id && (
                      <tr key={`${fin.id}-detail`}>
                        <td colSpan={5} className="px-4 pb-4">
                          <SectionDetail
                            sectionId={fin.section_id}
                            onClose={() => setExpandedSectionId(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
