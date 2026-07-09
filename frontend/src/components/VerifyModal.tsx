import { useEffect, useState } from 'react';
import type { VerifyJob } from '../types';
import { startVerify, getVerifyJob, verifyReportUrl, apiErrorMessage } from '../api';

/**
 * Generate & Verify: one click runs the whole chain internally —
 * generate (one-shot) → verify → fix (flagged only) → re-verify (judgment) →
 * deterministic checks → store the final deck. Produces a downloadable report of
 * every stage. Works on Claude and Gemini. Isolated from Generate and SBS.
 */
interface Props {
  sectionId: number;
  model: string;
  ruleSetId: number | null;
  cardVersion: string;
  onClose: () => void;
  onDone: () => void;
}

const VERSIONS = [
  { key: 'base', label: 'Current (base)' },
  { key: 'v1', label: 'v1' }, { key: 'v2', label: 'v2' }, { key: 'v3', label: 'v3' },
];

const PHASE_LABEL: Record<string, string> = {
  generate: 'Generating cards…',
  verify: 'Verifying against the rules…',
  fix: 'Fixing flagged cards…',
  reverify: 'Final judgment…',
  persist: 'Saving…',
};

export default function VerifyModal({ sectionId, model, ruleSetId, cardVersion, onClose, onDone }: Props) {
  const [version, setVersion] = useState(cardVersion || 'base');
  const [job, setJob] = useState<VerifyJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'failed') return;
    const t = setInterval(async () => {
      try {
        const j = await getVerifyJob(job.id);
        setJob(j);
        if (j.status === 'done') onDone();
      } catch { /* keep polling */ }
    }, 1500);
    return () => clearInterval(t);
  }, [job, onDone]);

  const running = busy || (job != null && (job.status === 'pending' || job.status === 'running'));
  const done = job?.status === 'done';
  const failed = job?.status === 'failed';

  async function run() {
    setBusy(true); setError(null);
    try {
      const j = await startVerify({ section_id: sectionId, rule_set_id: ruleSetId, card_version: version, model });
      setJob(j);
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to start'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !running && onClose()}>
      <div className="bg-white rounded-2xl shadow-2xl w-[560px] max-w-[94vw] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div>
            <h2 className="text-sm font-bold text-gray-900">Generate &amp; Verify</h2>
            <p className="text-[11px] text-gray-500">Generate → verify → fix → re-verify, all internal. Final deck + a full report.</p>
          </div>
          <button onClick={() => !running && onClose()} disabled={running} className="text-gray-400 hover:text-gray-600 p-1">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-4 py-4 space-y-3">
          {!job && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-xs text-gray-600 flex items-center gap-1.5">
                Cards go to:
                <select value={version} onChange={(e) => setVersion(e.target.value)}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {VERSIONS.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
                </select>
              </label>
              <span className="text-[11px] text-gray-400 ml-auto">model: {model}</span>
            </div>
          )}

          {error && <p className="text-[11px] text-red-600">{error}</p>}

          {job && !done && !failed && (
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <svg className="animate-spin h-4 w-4 text-blue-600" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              {PHASE_LABEL[job.phase] || 'Working…'}
            </div>
          )}

          {done && (
            <div className="text-xs text-green-700 font-medium">✓ Done — {job!.total_cards} card(s) in the deck.</div>
          )}
          {failed && <div className="text-xs text-red-600">Failed: {job!.error_message}</div>}
        </div>

        <div className="px-4 py-3 border-t border-gray-200 flex items-center gap-2">
          {done ? (
            <>
              <a href={verifyReportUrl(job!.id)} className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-white border border-blue-200 rounded-lg hover:bg-blue-50">
                ⬇ Download report (.md)
              </a>
              <button onClick={onClose} className="ml-auto px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800">Close</button>
            </>
          ) : failed ? (
            <button onClick={() => setJob(null)} className="ml-auto px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">Try again</button>
          ) : (
            <button onClick={run} disabled={running}
              className="ml-auto px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50">
              {running ? 'Running…' : 'Run'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
