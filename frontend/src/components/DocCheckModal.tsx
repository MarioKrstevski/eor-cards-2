import type { DocCheckReport } from '../api';

interface Props {
  report: DocCheckReport;
  onClose: () => void;
}

export default function DocCheckModal({ report, onClose }: Props) {
  const { summary, list_items, split_candidates, raw_xml, notes } = report;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-sm font-bold text-gray-900">Document check</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-6 space-y-6">

          {/* Summary */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Summary</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Paragraphs</p>
                <p className="text-xl font-bold text-gray-800">{summary.total_paragraphs}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">List items</p>
                <p className="text-xl font-bold text-gray-800">{summary.list_item_count}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">With soft breaks</p>
                <p className="text-xl font-bold text-gray-800">{summary.with_soft_break_count}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Split candidates</p>
                {summary.split_candidate_count > 0 ? (
                  <p className="text-xl font-bold text-red-600">{summary.split_candidate_count}</p>
                ) : (
                  <p className="text-xl font-bold text-green-600">0 — looks clean ✓</p>
                )}
              </div>
            </div>
          </section>

          {/* Split candidates */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Split candidates ({split_candidates.length})
            </h3>
            {split_candidates.length === 0 ? (
              <p className="text-xs text-gray-400 italic">No split bullets detected.</p>
            ) : (
              <div className="space-y-2">
                {split_candidates.map((sc, i) => (
                  <div key={i} className="border border-red-100 bg-red-50 rounded-lg p-3">
                    <p className="text-xs font-semibold text-gray-800 mb-1">{sc.text}</p>
                    <p className="text-[11px] text-gray-500 mb-0.5">
                      Continuation of: <span className="italic">{sc.prev_bullet_text}</span>
                    </p>
                    <p className="text-[11px] text-gray-400">Reason: {sc.reason}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* List items table */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              List items ({list_items.length})
            </h3>
            {list_items.length === 0 ? (
              <p className="text-xs text-gray-400 italic">No list items found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-10">#</th>
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium">Text</th>
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-24">Soft break</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list_items.map((item) => (
                      <tr key={item.index} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="py-1 px-2 text-gray-400 tabular-nums">{item.index}</td>
                        <td className="py-1 px-2 text-gray-700 truncate max-w-[400px]" title={item.text}>
                          {item.text.length > 80 ? item.text.slice(0, 80) + '…' : item.text}
                        </td>
                        <td className="py-1 px-2">
                          {item.has_soft_break ? (
                            <span className="text-amber-600 font-semibold">✓</span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Raw XML */}
          {raw_xml.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Raw XML ({raw_xml.length})
              </h3>
              <div className="space-y-1">
                {raw_xml.map((entry, i) => (
                  <details key={i} className="border border-gray-200 rounded-lg">
                    <summary className="px-3 py-2 text-xs text-gray-600 cursor-pointer hover:bg-gray-50 rounded-lg select-none">
                      #{entry.index} — {entry.kind}
                    </summary>
                    <pre className="text-xs font-mono bg-gray-50 p-2 mt-1 overflow-x-auto whitespace-pre rounded-b-lg">{entry.xml}</pre>
                  </details>
                ))}
              </div>
            </section>
          )}

          {/* Notes */}
          {notes.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Notes</h3>
              <ul className="space-y-1">
                {notes.map((note, i) => (
                  <li key={i} className="text-xs text-gray-500">{note}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
