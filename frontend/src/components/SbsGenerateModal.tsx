import { useEffect, useMemo, useState } from 'react';
import type { SbsRuleSet, SbsPreview, SbsJob } from '../types';
import {
  listSbsRules, sbsPreview, startSbs, getSbsJob, sbsReportUrl, apiErrorMessage,
} from '../api';

/**
 * Step-by-Step generation flow (isolated from the single-shot generate):
 * pick a step-by-step prompt → pick where the cards go → glance at what each
 * phase will send → Continue → the phased pipeline runs → cards land in the
 * chosen version, with a downloadable .md audit of every step.
 */
interface Props {
  sectionId: number;
  model: string;
  onClose: () => void;
  onDone: () => void; // refresh the card table
}

const VERSIONS = [
  { key: 'base', label: 'Current (base)' },
  { key: 'v1', label: 'v1' },
  { key: 'v2', label: 'v2' },
  { key: 'v3', label: 'v3' },
];

const PHASE_TITLE: Record<string, string> = {
  segment: 'Step 1 — Segment (decide units: standalone vs sibling)',
  author: 'Step 2 — Author (write the cloze card text)',
};

export default function SbsGenerateModal({ sectionId, model, onClose, onDone }: Props) {
  const [rules, setRules] = useState<SbsRuleSet[]>([]);
  const [ruleId, setRuleId] = useState<number | ''>('');
  const [version, setVersion] = useState('base');
  const [preview, setPreview] = useState<SbsPreview | null>(null);
  const [openPhase, setOpenPhase] = useState<string | null>('source');
  const [job, setJob] = useState<SbsJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listSbsRules().then((rs) => {
      setRules(rs);
      const def = rs.find((r) => r.is_default) ?? rs[0];
      if (def) setRuleId(def.id);
    }).catch((e) => setError(apiErrorMessage(e, 'Failed to load step-by-step rules')));
  }, []);

  // Load the preview whenever the section or chosen rule changes.
  useEffect(() => {
    setPreview(null);
    if (ruleId === '') return;
    sbsPreview(sectionId, ruleId)
      .then(setPreview)
      .catch((e) => setError(apiErrorMessage(e, 'Preview failed')));
  }, [sectionId, ruleId]);

  // Poll a running job to completion.
  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'failed') return;
    const t = setInterval(async () => {
      try {
        const j = await getSbsJob(job.id);
        setJob(j);
        if (j.status === 'done') { onDone(); }
      } catch { /* keep polling */ }
    }, 1500);
    return () => clearInterval(t);
  }, [job, onDone]);

  const running = busy || (job != null && (job.status === 'pending' || job.status === 'running'));

  const phaseChars = useMemo(() => {
    const m: Record<string, number> = {};
    preview?.phases.forEach((p) => { m[p.phase] = p.system.length; });
    return m;
  }, [preview]);

  async function start() {
    if (ruleId === '') return;
    setBusy(true); setError(null);
    try {
      const j = await startSbs({ section_id: sectionId, sbs_rule_set_id: ruleId, card_version: version, model });
      setJob(j);
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to start'));
    } finally {
      setBusy(false);
    }
  }

  const done = job?.status === 'done';
  const failed = job?.status === 'failed';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !running && onClose()}>
      <div className="bg-white rounded-2xl shadow-2xl w-[860px] max-w-[95vw] max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
          <div>
            <h2 className="text-sm font-bold text-gray-900">Generate — Step by Step</h2>
            <p className="text-[11px] text-gray-500">Phased pipeline: segment → author → assemble. Review what each step sends, then run it.</p>
          </div>
          <button onClick={() => !running && onClose()} className="text-gray-400 hover:text-gray-600 p-1" disabled={running}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Choices */}
        <div className="px-4 py-3 border-b border-gray-100 shrink-0 flex flex-wrap items-center gap-3">
          <label className="text-xs text-gray-600 flex items-center gap-1.5">
            Prompt:
            <select value={ruleId} onChange={(e) => setRuleId(e.target.value ? Number(e.target.value) : '')}
              disabled={running}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              {rules.map((r) => <option key={r.id} value={r.id}>{r.name}{r.is_default ? ' (default)' : ''}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-600 flex items-center gap-1.5">
            Cards go to:
            <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={running}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              {VERSIONS.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
            </select>
          </label>
          <span className="text-[11px] text-gray-400 ml-auto">model: {model}</span>
        </div>

        {/* Review panels */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {error && <p className="text-[11px] text-red-600">{error}</p>}
          {!preview && !error && <p className="text-xs text-gray-400 text-center py-6">Loading preview…</p>}
          {preview && (
            <>
              <Panel title={`Section source (what the model reads) — ${preview.section_heading}`}
                open={openPhase === 'source'} onToggle={() => setOpenPhase(openPhase === 'source' ? null : 'source')}>
                <pre className="text-[11px] whitespace-pre-wrap break-words font-mono">{preview.source}</pre>
              </Panel>
              {preview.phases.map((p) => (
                <Panel key={p.phase}
                  title={`${PHASE_TITLE[p.phase] ?? p.phase} — rules sent (${phaseChars[p.phase] ?? 0} chars)`}
                  open={openPhase === p.phase} onToggle={() => setOpenPhase(openPhase === p.phase ? null : p.phase)}>
                  <pre className="text-[11px] whitespace-pre-wrap break-words font-mono">{p.system}</pre>
                </Panel>
              ))}
              <p className="text-[10px] text-gray-400 px-1">
                Step 3 (assemble) is deterministic code: it builds sibling footers from the plan,
                blanks Column 3 for standalone cards, and normalizes the cloze index.
              </p>
            </>
          )}
        </div>

        {/* Footer / status */}
        <div className="px-4 py-3 border-t border-gray-200 shrink-0 flex items-center gap-2">
          {done ? (
            <>
              <span className="text-xs text-green-700 font-medium">✓ Done — {job!.total_cards} card(s) created.</span>
              <a href={sbsReportUrl(job!.id)} className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-white border border-blue-200 rounded-lg hover:bg-blue-50">
                ⬇ Download audit (.md)
              </a>
              <button onClick={onClose} className="ml-auto px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800">Close</button>
            </>
          ) : failed ? (
            <>
              <span className="text-xs text-red-600">Failed: {job!.error_message}</span>
              <button onClick={() => setJob(null)} className="ml-auto px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">Retry setup</button>
            </>
          ) : (
            <>
              <span className="text-[11px] text-gray-500">
                {running ? `Running… (${job?.phase || 'starting'})` : 'Review the steps above, then run.'}
              </span>
              <button onClick={start} disabled={running || ruleId === '' || !preview}
                className="ml-auto px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50">
                {running ? 'Running…' : 'Continue → run'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Panel({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-medium text-gray-700 bg-gray-50 hover:bg-gray-100">
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        <span className="truncate">{title}</span>
      </button>
      {open && <div className="p-3 max-h-64 overflow-auto bg-white">{children}</div>}
    </div>
  );
}
