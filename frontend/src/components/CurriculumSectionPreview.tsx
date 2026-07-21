import { useEffect, useMemo, useState } from 'react';
import { getSection } from '../api';
import type { CurriculumSection, SectionDetail } from '../types';

interface Props {
  expandedPath: string;
  sections: CurriculumSection[];
  onClose: () => void;
}

export default function CurriculumSectionPreview({ expandedPath, sections, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [chunks, setChunks] = useState<SectionDetail[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Sort same way as sidebar: orphans (exact path match) at bottom
    const sorted = [...sections].sort((a, b) => {
      const aOrphan = a.curriculum_topic_path === expandedPath;
      const bOrphan = b.curriculum_topic_path === expandedPath;
      if (aOrphan !== bOrphan) return aOrphan ? 1 : -1;
      return (a.curriculum_topic_path ?? '').localeCompare(b.curriculum_topic_path ?? '');
    });
    Promise.all(sorted.map(s => getSection(s.id)))
      .then(details => { if (!cancelled) { setChunks(details); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sections, expandedPath]);

  // A section is an orphan if it matched this exact node (not a deeper leaf)
  // We detect this by checking if any section went deeper (has longer path)
  const hasDeepSections = sections.some(s => (s.curriculum_topic_path ?? '').startsWith(expandedPath + ' > '));

  // Memoize the body: React 19 diffs dangerouslySetInnerHTML by OBJECT identity,
  // so inline {__html} literals would re-set every section's innerHTML on each
  // parent re-render (the 3s job poll) — the "flickering modal". Stable element
  // identity here makes React bail out of the whole subtree between loads.
  const body = useMemo(() => (
    <div className="flex-1 overflow-y-auto p-8 space-y-10">
      {chunks.map((chunk) => {
        const meta = sections.find(s => s.id === chunk.id);
        const isOrphan = hasDeepSections && meta?.curriculum_topic_path === expandedPath;
        const subPath = meta?.curriculum_topic_path
          ? meta.curriculum_topic_path.slice(expandedPath.length).replace(/^ > /, '')
          : '';
        return (
          <div key={chunk.id}>
            {/* Section heading bar */}
            <div className={`flex items-start gap-3 mb-4 pb-3 border-b ${isOrphan ? 'border-amber-200' : 'border-gray-200'}`}>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-gray-900">{chunk.heading}</h3>
                {subPath && (
                  <p className="text-xs text-gray-500 mt-0.5">{subPath}</p>
                )}
                {meta?.topic_tree_name && (
                  <p className="text-[10px] text-gray-400 mt-0.5">Source: {meta.topic_tree_name}</p>
                )}
              </div>
              {isOrphan && (
                <span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5 font-medium shrink-0 mt-0.5">
                  No leaf match
                </span>
              )}
              {chunk.card_count > 0 && (
                <span className="text-[10px] bg-blue-50 text-blue-700 border border-blue-100 rounded px-1.5 py-0.5 font-medium shrink-0 mt-0.5">
                  {chunk.card_count} cards
                </span>
              )}
            </div>
            {/* Section content */}
            <div
              className="section-content prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: chunk.content_html }}
            />
          </div>
        );
      })}
    </div>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [chunks, sections, expandedPath, hasDeepSections]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '90vw', maxWidth: '1100px', height: '85vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-200 shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-gray-900 truncate">{expandedPath}</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {sections.length} section{sections.length !== 1 ? 's' : ''} · combined preview
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-gray-400">Loading {sections.length} sections…</p>
          </div>
        ) : body}
      </div>
    </div>
  );
}
