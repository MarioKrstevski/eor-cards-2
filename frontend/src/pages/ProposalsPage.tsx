import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getFixBatches,
  getFixBatch,
  confirmFixBatch,
  cancelFixBatch,
  rerunFixBatch,
  updateFixProposal,
} from '../api';
import type { FixBatch, FixProposal } from '../types';
import SectionViewer from './SectionViewer';

// ── helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StatusBadge({ status }: { status: FixBatch['status'] }) {
  const map: Record<FixBatch['status'], string> = {
    pending: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    running: 'bg-blue-50 text-blue-700 border-blue-200',
    done: 'bg-green-50 text-green-700 border-green-200',
    confirmed: 'bg-gray-100 text-gray-500 border-gray-200',
    cancelled: 'bg-red-50 text-red-500 border-red-200',
  };
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${map[status]}`}>
      {status === 'running' ? '⟳ running' : status}
    </span>
  );
}

function AiActionBadge({ action }: { action: string }) {
  const map: Record<string, string> = {
    edit: 'bg-amber-50 text-amber-700',
    keep: 'bg-green-50 text-green-700',
    delete: 'bg-red-50 text-red-600',
    split: 'bg-purple-50 text-purple-700',
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wide ${map[action] ?? 'bg-gray-50 text-gray-500'}`}>
      {action}
    </span>
  );
}

function CardHtml({ html }: { html: string | null }) {
  if (!html) return <span className="text-gray-400 italic text-xs">(none)</span>;
  return (
    <div
      className="text-xs text-gray-800 leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ── Proposal row ──────────────────────────────────────────────────────────────

interface ProposalRowProps {
  proposal: FixProposal;
  batchId: number;
  batchStatus: FixBatch['status'];
  onResolved: (updated: FixProposal) => void;
  onViewSection: (sectionId: number) => void;
}

function ProposalRow({ proposal, batchId, batchStatus, onResolved, onViewSection }: ProposalRowProps) {
  const [loading, setLoading] = useState(false);
  const isEditable = batchStatus === 'done' && !proposal.is_resolved;

  async function choose(action: string) {
    setLoading(true);
    try {
      const updated = await updateFixProposal(batchId, proposal.id, action);
      onResolved(updated);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`border rounded-xl overflow-hidden transition-opacity ${proposal.is_resolved ? 'opacity-60' : 'opacity-100'}`}>
      {/* top bar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b">
        <span className="text-[10px] text-gray-400 font-mono">#{proposal.original_card_id}</span>
        <span className="text-[10px] text-gray-400">AI:</span>
        <AiActionBadge action={proposal.ai_action} />
        {proposal.is_resolved && (
          <>
            <span className="text-[10px] text-gray-400 ml-1">→ you:</span>
            <AiActionBadge action={proposal.reviewer_action ?? proposal.ai_action} />
          </>
        )}
        <div className="flex-1" />
        {proposal.is_resolved && (
          <span className="text-[10px] text-green-600 font-medium">resolved</span>
        )}
        {proposal.original_section_id != null && (
          <button
            onClick={() => onViewSection(proposal.original_section_id!)}
            className="text-[10px] text-blue-600 hover:text-blue-800 px-1.5 py-0.5 rounded hover:bg-blue-50 transition-colors"
            title="View source section"
          >
            View Source
          </button>
        )}
      </div>

      {/* body */}
      <div className="grid grid-cols-2 divide-x">
        {/* original */}
        <div className="px-4 py-3">
          <div className="text-[9px] font-bold text-gray-400 uppercase tracking-wide mb-1.5">Original</div>
          <CardHtml html={proposal.original_front_html ?? null} />
          {proposal.original_extra && (
            <div className="mt-2 text-[10px] text-gray-500 border-t pt-2">
              <span className="font-semibold text-gray-400">Extra: </span>
              {proposal.original_extra}
            </div>
          )}
          {proposal.original_tags && proposal.original_tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {proposal.original_tags.map((t) => (
                <span key={t} className="text-[9px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{t}</span>
              ))}
            </div>
          )}
        </div>

        {/* proposed */}
        <div className="px-4 py-3">
          <div className="text-[9px] font-bold text-gray-400 uppercase tracking-wide mb-1.5">Proposed</div>
          {proposal.ai_action === 'keep' && (
            <span className="text-xs text-green-600 font-medium">No change needed</span>
          )}
          {proposal.ai_action === 'delete' && (
            <span className="text-xs text-red-500 font-medium">Delete card</span>
          )}
          {proposal.ai_action === 'edit' && (
            <>
              <CardHtml html={proposal.proposed_front_html} />
              {proposal.proposed_extra && (
                <div className="mt-2 text-[10px] text-gray-500 border-t pt-2">
                  <span className="font-semibold text-gray-400">Extra: </span>
                  {proposal.proposed_extra}
                </div>
              )}
            </>
          )}
          {proposal.ai_action === 'split' && proposal.new_cards_json && (
            <div className="space-y-2">
              {proposal.new_cards_json.map((nc, i) => (
                <div key={i} className="border rounded-lg px-3 py-2 bg-purple-50/50">
                  <div className="text-[9px] font-bold text-purple-400 mb-1">Card {i + 1}</div>
                  <CardHtml html={nc.front_html} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* action buttons */}
      {isEditable && (
        <div className="flex items-center gap-2 px-4 py-2.5 border-t bg-gray-50/50">
          <span className="text-[10px] text-gray-400 mr-1">Decision:</span>
          <button
            onClick={() => choose(proposal.ai_action)}
            disabled={loading}
            className="text-xs font-medium px-2.5 py-1 rounded-lg bg-blue-700 text-white hover:bg-blue-800 transition-colors disabled:opacity-50"
          >
            Accept AI ({proposal.ai_action})
          </button>
          {proposal.ai_action !== 'keep' && (
            <button
              onClick={() => choose('keep')}
              disabled={loading}
              className="text-xs font-medium px-2.5 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              Keep original
            </button>
          )}
          {proposal.ai_action !== 'delete' && (
            <button
              onClick={() => choose('delete')}
              disabled={loading}
              className="text-xs font-medium px-2.5 py-1 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Batch detail panel ────────────────────────────────────────────────────────

interface BatchDetailProps {
  batchId: number;
  onBatchUpdated: (b: FixBatch) => void;
}

function BatchDetail({ batchId, onBatchUpdated }: BatchDetailProps) {
  const [batch, setBatch] = useState<FixBatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [rerunPrompt, setRerunPrompt] = useState('');
  const [showRerun, setShowRerun] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [viewSectionId, setViewSectionId] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Use a ref for the callback to avoid it as a dep (it's recreated every render in parent)
  const onBatchUpdatedRef = useRef(onBatchUpdated);
  useEffect(() => { onBatchUpdatedRef.current = onBatchUpdated; });

  const load = useCallback(async () => {
    try {
      const b = await getFixBatch(batchId);
      setBatch(b);
      onBatchUpdatedRef.current(b);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [batchId]); // stable — onBatchUpdated accessed via ref

  useEffect(() => {
    setLoading(true);
    setBatch(null);
    load();
  }, [batchId, load]);

  // Poll while running/pending using a ref to avoid stale closure
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (batch?.status === 'running' || batch?.status === 'pending') {
      pollRef.current = setInterval(() => { load(); }, 3000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.status]);

  function updateProposal(updated: FixProposal) {
    setBatch((b) => {
      if (!b) return b;
      return {
        ...b,
        proposals: b.proposals?.map((p) => p.id === updated.id ? { ...p, ...updated } : p),
      };
    });
  }

  async function handleConfirm() {
    if (!batch) return;
    setConfirming(true);
    try {
      await confirmFixBatch(batch.id);
      await load();
    } finally {
      setConfirming(false);
    }
  }

  async function handleCancel() {
    if (!batch) return;
    setCancelling(true);
    try {
      await cancelFixBatch(batch.id);
      await load();
    } finally {
      setCancelling(false);
    }
  }

  async function handleRerun() {
    if (!batch || !rerunPrompt.trim()) return;
    setRerunning(true);
    try {
      await rerunFixBatch(batch.id, rerunPrompt.trim());
      setShowRerun(false);
      setRerunPrompt('');
      await load();
    } finally {
      setRerunning(false);
    }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Loading…</div>;
  }
  if (!batch) {
    return <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Not found</div>;
  }

  const proposals = batch.proposals ?? [];
  const resolved = proposals.filter((p) => p.is_resolved).length;
  const allResolved = proposals.length > 0 && resolved === proposals.length;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* header */}
      <div className="shrink-0 px-6 py-4 border-b bg-white">
        <div className="flex items-center gap-3 mb-2">
          {batch.mark_type_color && (
            <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ backgroundColor: batch.mark_type_color }} />
          )}
          <h2 className="text-sm font-semibold text-gray-900">
            {batch.mark_type_name ?? 'Fix Batch'} — Batch #{batch.id}
          </h2>
          <StatusBadge status={batch.status} />
          <div className="flex-1" />
          {(batch.status === 'running' || batch.status === 'pending') && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="text-xs font-medium px-3 py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              {cancelling ? 'Cancelling…' : 'Cancel Batch'}
            </button>
          )}
          {batch.status === 'done' && (
            <>
              <button
                onClick={() => { setShowRerun(!showRerun); setRerunPrompt(batch.prompt); }}
                className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Rerun
              </button>
              <button
                onClick={handleConfirm}
                disabled={confirming || !allResolved}
                title={!allResolved ? `Resolve all proposals first (${resolved}/${proposals.length} done)` : 'Apply changes to cards'}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-700 text-white hover:bg-blue-800 transition-colors disabled:opacity-40"
              >
                {confirming ? 'Applying…' : `Confirm All (${resolved}/${proposals.length})`}
              </button>
            </>
          )}
        </div>

        {/* progress bar for running */}
        {(batch.status === 'running' || batch.status === 'pending') && (
          <div className="mt-2">
            <div className="flex justify-between text-[10px] text-gray-400 mb-1">
              <span>AI reviewing cards…</span>
              <span>{batch.processed_cards} / {batch.total_cards}</span>
            </div>
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-500"
                style={{ width: batch.total_cards > 0 ? `${(batch.processed_cards / batch.total_cards) * 100}%` : '0%' }}
              />
            </div>
          </div>
        )}

        {/* prompt */}
        <div className="mt-2 text-xs text-gray-500">
          <span className="font-medium text-gray-600">Prompt: </span>
          {batch.prompt}
        </div>
        <div className="mt-1 text-[10px] text-gray-400">
          Model: {batch.model} · {batch.total_cards} cards · created {relativeTime(batch.created_at)}
          {batch.finished_at && ` · finished ${relativeTime(batch.finished_at)}`}
        </div>

        {/* rerun form */}
        {showRerun && (
          <div className="mt-3 flex gap-2">
            <textarea
              value={rerunPrompt}
              onChange={(e) => setRerunPrompt(e.target.value)}
              rows={2}
              placeholder="Updated fix instruction…"
              className="flex-1 text-xs border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
            />
            <div className="flex flex-col gap-1.5">
              <button
                onClick={handleRerun}
                disabled={rerunning || !rerunPrompt.trim()}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-700 text-white hover:bg-blue-800 disabled:opacity-40"
              >
                {rerunning ? 'Starting…' : 'Rerun'}
              </button>
              <button onClick={() => setShowRerun(false)} className="text-xs text-gray-500 hover:text-gray-700">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* proposals list */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {(batch.status === 'pending' || batch.status === 'running') && proposals.length === 0 && (
          <div className="text-center text-sm text-gray-400 py-12">
            <div className="animate-spin w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-3" />
            AI is reviewing cards…
          </div>
        )}
        {batch.status === 'confirmed' && (
          <div className="text-center text-sm text-green-600 font-medium py-4">
            All changes have been applied to cards.
          </div>
        )}
        {proposals.map((p) => (
          <ProposalRow
            key={p.id}
            proposal={p}
            batchId={batch.id}
            batchStatus={batch.status}
            onResolved={updateProposal}
            onViewSection={setViewSectionId}
          />
        ))}
        {proposals.length === 0 && batch.status === 'done' && (
          <div className="text-center text-sm text-gray-400 py-12">No proposals generated.</div>
        )}
      </div>

      {viewSectionId != null && (
        <SectionViewer sectionId={viewSectionId} onClose={() => setViewSectionId(null)} />
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ProposalsPage() {
  const [batches, setBatches] = useState<FixBatch[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selectedIdRef = useRef<number | null>(null);

  const loadBatches = useCallback(async () => {
    const list = await getFixBatches();
    setBatches(list);
    // Auto-select first batch only on initial load
    if (list.length > 0 && selectedIdRef.current === null) {
      selectedIdRef.current = list[0].id;
      setSelectedId(list[0].id);
    }
  }, []); // stable — no deps

  useEffect(() => {
    loadBatches();
  }, [loadBatches]);

  const hasRunningBatches = batches.some((b) => b.status === 'running' || b.status === 'pending');

  // Poll when there are active batches
  useEffect(() => {
    if (!hasRunningBatches) return;
    const id = setInterval(loadBatches, 5000);
    return () => clearInterval(id);
  }, [hasRunningBatches, loadBatches]);

  function handleSelect(id: number) {
    selectedIdRef.current = id;
    setSelectedId(id);
  }

  function handleBatchUpdated(updated: FixBatch) {
    setBatches((prev) => prev.map((b) => b.id === updated.id ? { ...b, status: updated.status, processed_cards: updated.processed_cards, finished_at: updated.finished_at } : b));
  }

  return (
    <div className="flex-1 flex min-h-0">
      {/* left: batch list */}
      <div className="w-64 shrink-0 border-r bg-gray-50 flex flex-col min-h-0">
        <div className="px-4 py-3 border-b bg-white flex items-center gap-2">
          <h1 className="text-xs font-bold text-gray-700 uppercase tracking-wide">Fix Batches</h1>
          {hasRunningBatches && (
            <span className="ml-auto flex items-center gap-1 text-[10px] text-blue-600">
              <span className="animate-spin w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full inline-block" />
              running
            </span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {batches.length === 0 && (
            <div className="px-4 py-6 text-xs text-gray-400 text-center">
              No batches yet. Select marked cards in Workspace → AI Fix Batch.
            </div>
          )}
          {batches.map((b) => (
            <button
              key={b.id}
              onClick={() => handleSelect(b.id)}
              className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-white transition-colors ${
                selectedId === b.id ? 'bg-white border-l-2 border-l-blue-600' : ''
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                {b.mark_type_color && (
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: b.mark_type_color }} />
                )}
                <span className="text-xs font-medium text-gray-800 truncate flex-1">
                  {b.mark_type_name ?? `Batch #${b.id}`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={b.status} />
                <span className="text-[10px] text-gray-400 ml-auto">
                  {b.processed_cards}/{b.total_cards}
                </span>
              </div>
              <div className="text-[10px] text-gray-400 mt-0.5">{relativeTime(b.created_at)}</div>
            </button>
          ))}
        </div>
      </div>

      {/* right: detail */}
      {selectedId == null ? (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
          Select a batch to review proposals
        </div>
      ) : (
        <BatchDetail
          key={selectedId}
          batchId={selectedId}
          onBatchUpdated={handleBatchUpdated}
        />
      )}
    </div>
  );
}
