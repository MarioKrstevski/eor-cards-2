import type { DocCheckReport } from '../api';

interface Props {
  report: DocCheckReport;
  fileName?: string;
  onClose: () => void;
}

export default function DocCheckModal({ report, fileName, onClose }: Props) {
  const {
    summary,
    soft_break_items,
    split_candidates,
    typed_bullets,
    heading_issues,
    empty_list_items,
    long_paragraphs,
    unparseable,
    weird_chars,
    raw_xml,
    notes,
  } = report;
  const pagesEst = summary.pages_estimated;

  const chipBase = 'rounded-lg p-3';
  const chipNeutral = `${chipBase} bg-gray-50`;
  const chipRed = `${chipBase} bg-red-50`;
  const chipGreen = `${chipBase} bg-green-50`;

  const countChip = (count: number, neutral = false) => {
    if (neutral) return <p className="text-xl font-bold text-gray-800">{count}</p>;
    if (count === 0) return <p className="text-xl font-bold text-green-600">0 ✓</p>;
    return <p className="text-xl font-bold text-red-600">{count}</p>;
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-gray-900">Document check</h2>
            {fileName && (
              <p className="text-xs text-gray-500 truncate max-w-[560px]" title={fileName}>{fileName}</p>
            )}
          </div>
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

          {/* Summary chip grid */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Summary</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
              <div className={chipNeutral}>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Paragraphs</p>
                {countChip(summary.total_paragraphs, true)}
              </div>
              <div className={summary.with_soft_break_count > 0 ? chipRed : chipNeutral}>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Soft breaks</p>
                {countChip(summary.with_soft_break_count)}
              </div>
              <div className={summary.split_candidate_count > 0 ? chipRed : chipNeutral}>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Split candidates</p>
                {countChip(summary.split_candidate_count)}
              </div>
              <div className={summary.typed_bullet_count > 0 ? chipRed : chipNeutral}>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Typed bullets</p>
                {countChip(summary.typed_bullet_count)}
              </div>
              <div className={summary.heading_issue_count > 0 ? chipRed : chipNeutral}>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Heading issues</p>
                {countChip(summary.heading_issue_count)}
              </div>
              <div className={summary.empty_list_item_count > 0 ? chipRed : chipNeutral}>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Empty items</p>
                {countChip(summary.empty_list_item_count)}
              </div>
              <div className={summary.long_paragraph_count > 0 ? chipRed : chipNeutral}>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Long paras</p>
                {countChip(summary.long_paragraph_count)}
              </div>
              <div className={summary.weird_char_count > 0 ? chipRed : chipNeutral}>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Weird chars</p>
                {countChip(summary.weird_char_count)}
              </div>
            </div>
            {/* Unparseable content line */}
            <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-600">
              <span className="font-medium text-gray-500 uppercase tracking-wide text-[10px] mr-2">Unparseable:</span>
              Tables {summary.unparseable.tables} · Text boxes {summary.unparseable.text_boxes} · Drawings {summary.unparseable.drawings}
            </div>
          </section>

          {/* ── Soft-break paragraphs ── */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Soft-break paragraphs ({soft_break_items.length})
            </h3>
            <p className="text-[11px] text-gray-400 mb-3">
              Every paragraph that still contains a soft line break (Shift+Enter / <code>&lt;w:br/&gt;</code>).
              These are the ones to open in Word and check — <b>#</b> is the paragraph's position in the document.
            </p>
            {soft_break_items.length === 0 ? (
              <p className="text-xs text-gray-400 italic">None found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-12">#</th>
                      {pagesEst && <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-14">Page</th>}
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium">Text</th>
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-16">Type</th>
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-16">Breaks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {soft_break_items.map((item) => (
                      <tr key={item.index} className="border-b border-gray-50 hover:bg-amber-50/40">
                        <td className="py-1 px-2 text-gray-400 tabular-nums">{item.index}</td>
                        {pagesEst && <td className="py-1 px-2 text-gray-500 tabular-nums">~{item.page}</td>}
                        <td className="py-1 px-2 text-gray-700" title={item.text}>
                          {item.text.length > 90 ? item.text.slice(0, 90) + '…' : (item.text || <span className="text-gray-300 italic">(empty)</span>)}
                        </td>
                        <td className="py-1 px-2 text-gray-500">{item.is_list ? 'list' : 'text'}</td>
                        <td className="py-1 px-2 text-amber-600 font-semibold tabular-nums">{item.soft_break_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Split candidates ── */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Split candidates ({split_candidates.length})
            </h3>
            <p className="text-[11px] text-gray-400 mb-3">
              A <b>guess</b> at bullets that broke onto a separate un-bulleted paragraph on export
              (a non-list paragraph right after a bullet, indented or with a "List" style). Heuristic — confirm before editing.
            </p>
            {split_candidates.length === 0 ? (
              <p className="text-xs text-gray-400 italic">None found.</p>
            ) : (
              <div className="space-y-2">
                {split_candidates.map((sc, i) => (
                  <div key={i} className="border border-red-100 bg-red-50 rounded-lg p-3">
                    <p className="text-[10px] text-gray-400 tabular-nums mb-0.5">
                      #{sc.index}{pagesEst && ` · ~page ${sc.page}`}
                    </p>
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

          {/* ── Typed bullets ── */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Typed bullets ({typed_bullets.length})
            </h3>
            <p className="text-[11px] text-gray-400 mb-3">
              Bullets typed as text (•, -, *, or "1.") instead of real Word list formatting — Word won't treat these as list items, so they can split or merge wrong.
            </p>
            {typed_bullets.length === 0 ? (
              <p className="text-xs text-gray-400 italic">None found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-12">#</th>
                      {pagesEst && <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-14">Page</th>}
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-14">Marker</th>
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium">Text</th>
                    </tr>
                  </thead>
                  <tbody>
                    {typed_bullets.map((item) => (
                      <tr key={item.index} className="border-b border-gray-50 hover:bg-orange-50/40">
                        <td className="py-1 px-2 text-gray-400 tabular-nums">{item.index}</td>
                        {pagesEst && <td className="py-1 px-2 text-gray-500 tabular-nums">~{item.page}</td>}
                        <td className="py-1 px-2 text-orange-600 font-mono font-semibold">{item.marker}</td>
                        <td className="py-1 px-2 text-gray-700" title={item.text}>
                          {item.text.length > 90 ? item.text.slice(0, 90) + '…' : item.text}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Heading issues ── */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Heading issues ({heading_issues.length})
            </h3>
            <p className="text-[11px] text-gray-400 mb-3">
              Headings Word won't treat correctly: bold text used as a heading but not styled Heading 1-4 (won't become its own section), or heading levels that skip (e.g. Heading 1 → Heading 3).
            </p>
            {heading_issues.length === 0 ? (
              <p className="text-xs text-gray-400 italic">None found.</p>
            ) : (
              <div className="space-y-2">
                {heading_issues.map((item, i) => (
                  <div key={i} className="border border-orange-100 bg-orange-50 rounded-lg p-3">
                    <p className="text-[10px] text-gray-400 tabular-nums mb-0.5">
                      #{item.index}{pagesEst && ` · ~page ${item.page}`}
                      {' · '}<span className="font-medium text-orange-600">{item.kind === 'fake_heading' ? 'fake heading' : 'skipped level'}</span>
                    </p>
                    <p className="text-xs font-semibold text-gray-800 mb-1">{item.text || <span className="text-gray-400 italic">(empty)</span>}</p>
                    <p className="text-[11px] text-gray-500">{item.detail}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Empty list items ── */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Empty list items ({empty_list_items.length})
            </h3>
            <p className="text-[11px] text-gray-400 mb-3">
              Bullets with no text — stray or empty list items.
            </p>
            {empty_list_items.length === 0 ? (
              <p className="text-xs text-gray-400 italic">None found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-12">#</th>
                      {pagesEst && <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-14">Page</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {empty_list_items.map((item) => (
                      <tr key={item.index} className="border-b border-gray-50 hover:bg-gray-100/40">
                        <td className="py-1 px-2 text-gray-400 tabular-nums">{item.index}</td>
                        {pagesEst && <td className="py-1 px-2 text-gray-500 tabular-nums">~{item.page}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Long paragraphs ── */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Long paragraphs ({summary.long_paragraph_count}
              {summary.long_paragraph_count > 50 ? `, showing top 50` : ``})
            </h3>
            <p className="text-[11px] text-gray-400 mb-3">
              Very long paragraphs (over 400 characters) — often several facts merged together that may need splitting into separate points.
            </p>
            {long_paragraphs.length === 0 ? (
              <p className="text-xs text-gray-400 italic">None found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-12">#</th>
                      {pagesEst && <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-14">Page</th>}
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-16">Chars</th>
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium">Text</th>
                    </tr>
                  </thead>
                  <tbody>
                    {long_paragraphs.map((item) => (
                      <tr key={item.index} className="border-b border-gray-50 hover:bg-yellow-50/40">
                        <td className="py-1 px-2 text-gray-400 tabular-nums">{item.index}</td>
                        {pagesEst && <td className="py-1 px-2 text-gray-500 tabular-nums">~{item.page}</td>}
                        <td className="py-1 px-2 text-yellow-700 font-semibold tabular-nums">{item.char_count}</td>
                        <td className="py-1 px-2 text-gray-700" title={item.text}>
                          {item.text.length > 120 ? item.text.slice(0, 120) + '…' : item.text}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Unparseable content ── */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Unparseable content
            </h3>
            <p className="text-[11px] text-gray-400 mb-3">
              Content Word stores in ways this tool doesn't parse into cards — native tables, text boxes, and drawings/shapes. Shown as counts so you know what won't come through as text.
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div className={unparseable.tables > 0 ? chipRed : chipNeutral}>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Tables</p>
                <p className={`text-xl font-bold ${unparseable.tables > 0 ? 'text-red-600' : 'text-gray-800'}`}>{unparseable.tables}</p>
              </div>
              <div className={unparseable.text_boxes > 0 ? chipRed : chipNeutral}>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Text boxes</p>
                <p className={`text-xl font-bold ${unparseable.text_boxes > 0 ? 'text-red-600' : 'text-gray-800'}`}>{unparseable.text_boxes}</p>
              </div>
              <div className={unparseable.drawings > 0 ? chipRed : chipNeutral}>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Drawings</p>
                <p className={`text-xl font-bold ${unparseable.drawings > 0 ? 'text-red-600' : 'text-gray-800'}`}>{unparseable.drawings}</p>
              </div>
            </div>
          </section>

          {/* ── Weird characters ── */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Weird characters ({summary.weird_char_count}
              {summary.weird_char_count > 100 ? `, showing first 100` : ``})
            </h3>
            <p className="text-[11px] text-gray-400 mb-3">
              Characters that cause display problems: non-breaking spaces, zero-width characters, replacement chars (&#65533;), or mojibake (Ã / â€) from a bad encoding.
            </p>
            {weird_chars.length === 0 ? (
              <p className="text-xs text-gray-400 italic">None found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-12">#</th>
                      {pagesEst && <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-14">Page</th>}
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium w-40">Issue types</th>
                      <th className="text-left py-1.5 px-2 text-[10px] text-gray-400 font-medium">Text</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weird_chars.map((item) => (
                      <tr key={item.index} className="border-b border-gray-50 hover:bg-purple-50/40">
                        <td className="py-1 px-2 text-gray-400 tabular-nums">{item.index}</td>
                        {pagesEst && <td className="py-1 px-2 text-gray-500 tabular-nums">~{item.page}</td>}
                        <td className="py-1 px-2">
                          <div className="flex flex-wrap gap-1">
                            {item.kinds.map((k, ki) => (
                              <span key={ki} className="bg-purple-100 text-purple-700 text-[10px] px-1.5 py-0.5 rounded">{k}</span>
                            ))}
                          </div>
                        </td>
                        <td className="py-1 px-2 text-gray-700" title={item.text}>
                          {item.text.length > 90 ? item.text.slice(0, 90) + '…' : item.text}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Raw XML ── */}
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

          {/* ── Notes ── */}
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
