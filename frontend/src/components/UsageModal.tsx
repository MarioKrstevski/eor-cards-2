import { useEffect, useRef, useState } from 'react';
import { getUsageSummary } from '../api';
import type { AIUsageSummary } from '../types';

const OPERATION_LABELS: Record<string, string> = {
  chunking: 'Chunking',
  topic_detection: 'Topic Detection',
  card_generation: 'Card Generation',
  card_regen: 'Card Regen',
};

const OPERATION_COLORS: Record<string, string> = {
  chunking: 'bg-blue-50 text-blue-700',
  topic_detection: 'bg-amber-50 text-amber-700',
  card_generation: 'bg-blue-50 text-blue-700',
  card_regen: 'bg-emerald-50 text-emerald-700',
};

export default function UsageModal({ onClose }: { onClose: () => void }) {
  const [summary, setSummary] = useState<AIUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getUsageSummary()
      .then(setSummary)
      .catch(() => setError('Failed to load usage data'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const operations = summary
    ? Object.entries(summary.by_operation).sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      aria-modal="true"
      role="dialog"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />

      <div className="relative bg-white rounded-2xl shadow-lg w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">AI Usage & Cost</h2>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-50 transition-colors duration-150"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          {loading ? (
            <p className="text-sm text-gray-400 text-center py-8">Loading...</p>
          ) : error ? (
            <p className="text-sm text-red-500 text-center py-8">{error}</p>
          ) : summary ? (
            <>
              {/* Total cost — big centered number */}
              <div className="flex flex-col items-center mb-6 py-2">
                <p className="text-4xl font-bold text-blue-700 tabular-nums tracking-tight">
                  ${summary.total_cost_usd.toFixed(4)}
                </p>
                <p className="text-xs text-gray-400 mt-1.5 font-medium">Total AI spend</p>
              </div>

              {/* Breakdown table */}
              {operations.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">No usage recorded yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-gray-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50/80">
                        <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                          Operation
                        </th>
                        <th className="px-4 py-3 text-right text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                          Calls
                        </th>
                        <th className="px-4 py-3 text-right text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                          Tokens In
                        </th>
                        <th className="px-4 py-3 text-right text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                          Tokens Out
                        </th>
                        <th className="px-4 py-3 text-right text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                          Cost
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {operations.map(([op, stats]) => (
                        <tr
                          key={op}
                          className="border-t border-gray-50 hover:bg-gray-50/50 transition-colors duration-150"
                        >
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${OPERATION_COLORS[op] ?? 'bg-gray-50 text-gray-600'}`}>
                              {OPERATION_LABELS[op] ?? op}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right text-gray-600 tabular-nums">
                            {stats.count.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-600 tabular-nums">
                            {stats.input_tokens.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-600 tabular-nums">
                            {stats.output_tokens.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right text-blue-700 font-semibold tabular-nums">
                            ${stats.cost_usd.toFixed(4)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}
        </div>

        <div className="px-6 pb-5 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-gray-200"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
