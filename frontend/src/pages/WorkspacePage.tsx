import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getTopicTrees,
  getTopicTree,
  getCurriculum,
  getCurriculumCoverage,
  uploadDocument,
  pasteDocument,
  deleteTopicTree,
  getProcessingJob,
  getActiveJobs,
  getSectionsByCurriculum,
  estimateCost,
  startGeneration,
  startSupplemental,
  getGenerationJob,
  getSection,
  createCurriculumNode,
  updateSection,
} from '../api';
import type { GenerationJob, CurriculumSection, CostEstimate, SectionDetail, ReconcileDiff } from '../types';
import type {
  CurriculumNode,
  TopicCoverageStats,
  TopicTree,
  Section,
} from '../types';
import CardsPanel from './CardsPanel';
import SectionViewer from './SectionViewer';
import ConfirmModal from '../components/ConfirmModal';
import ReconcileModal from '../components/ReconcileModal';
import CurriculumPicker from '../components/CurriculumPicker';
import CurriculumSectionPreview from '../components/CurriculumSectionPreview';
import { buildAggregatedCounts, sortTree } from '../utils';
import { useSettings } from '../context/SettingsContext';

// ── TopicNode: read-only collapsible curriculum node for sidebar tree ─────────

const TOPIC_LEVEL_BADGE = ['bg-purple-50 text-purple-700', 'bg-blue-50 text-blue-700', 'bg-green-50 text-green-700', 'bg-orange-50 text-orange-700'];

// ── SectionTree: group sections by curriculum path levels, Reddit-style nesting ─

interface SectionLike {
  id: number;
  heading: string;
  curriculum_topic_path: string | null;
  card_count: number;
  section_status: 'normal' | 'green' | 'orange';
  is_verified: boolean;
  is_done: boolean;
  flags: string[] | null;
}

interface SectionTreeNode<T extends SectionLike> {
  label: string;
  sections: T[];
  children: Map<string, SectionTreeNode<T>>;
}

function buildSectionTree<T extends SectionLike>(sections: T[], treeName: string, basePath?: string): SectionTreeNode<T> {
  const root: SectionTreeNode<T> = { label: treeName, sections: [], children: new Map() };
  for (const section of sections) {
    const path = section.curriculum_topic_path;
    if (!path) {
      root.sections.push(section);
      continue;
    }
    // Strip the basePath prefix if provided (for curriculum action bar)
    let relativePath = path;
    if (basePath && relativePath.startsWith(basePath)) {
      relativePath = relativePath.slice(basePath.length).replace(/^ > /, '');
    }
    const parts = relativePath.split(' > ');
    // Last part is the leaf (section heading), everything before is grouping
    const groupParts = parts.length > 1 ? parts.slice(0, -1) : [];
    let node = root;
    for (const part of groupParts) {
      if (!node.children.has(part)) {
        node.children.set(part, { label: part, sections: [], children: new Map() });
      }
      node = node.children.get(part)!;
    }
    node.sections.push(section);
  }
  return root;
}

function SectionTreeGroup<T extends SectionLike>({
  node,
  depth,
  treeName,
  selectedSectionId,
  onSelectSection,
  onViewSection,
  renderSubtitle,
  onSectionMoved,
  onSelectGroup,
}: {
  node: SectionTreeNode<T>;
  depth: number;
  treeName: string;
  selectedSectionId: number | null;
  onSelectSection: (s: T) => void;
  onViewSection: (id: number) => void;
  renderSubtitle?: (s: T) => React.ReactNode;
  onSectionMoved?: () => void;
  onSelectGroup?: (sectionIds: number[]) => void;
}) {
  const [collapsed, setCollapsed] = useState(depth > 0);
  const [viewingGroup, setViewingGroup] = useState(false);
  const borderOpacity = Math.min(20 + depth * 10, 60);

  // Collect all section IDs in this subtree
  const collectIds = (n: SectionTreeNode<T>): number[] => [
    ...n.sections.map(s => s.id),
    ...Array.from(n.children.values()).flatMap(c => collectIds(c)),
  ];
  const collectSecs = (n: SectionTreeNode<T>): T[] => [
    ...n.sections,
    ...Array.from(n.children.values()).flatMap(c => collectSecs(c)),
  ];
  const groupSecs = collectSecs(node);
  const allDone = groupSecs.length > 0 && groupSecs.every(s => s.is_done);
  const totalCards = node.sections.reduce((sum, s) => sum + (s.card_count || 0), 0)
    + Array.from(node.children.values()).reduce((sum, child) => {
      const countAll = (n: SectionTreeNode<T>): number =>
        n.sections.reduce((s, sec) => s + (sec.card_count || 0), 0) + Array.from(n.children.values()).reduce((s, c) => s + countAll(c), 0);
      return sum + countAll(child);
    }, 0);

  return (
    <div className={depth > 0 ? 'ml-2.5' : ''} style={{ borderLeft: `2px solid rgba(156,163,175,${borderOpacity / 100})` }}>
      {depth > 0 && (
        <>
          <div
            className="flex items-center gap-1.5 pl-2 pr-2 py-1 hover:bg-gray-50"
          >
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="p-0.5 -m-0.5 shrink-0 cursor-pointer"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className={`h-3 w-3 text-gray-400 transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <span
              className="text-xs font-medium text-gray-600 truncate flex-1 cursor-pointer hover:text-blue-600"
              onClick={() => {
                onSelectGroup?.(collectIds(node));
              }}
            >
              {allDone && (
                <svg className="inline-block h-3 w-3 mr-0.5 -mt-0.5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
              {node.label}
            </span>
            {totalCards > 0 && <span className="text-[9px] text-gray-400 tabular-nums shrink-0">{totalCards}</span>}
            <button
              onClick={(e) => { e.stopPropagation(); setViewingGroup(true); }}
              className="p-1 rounded text-gray-300 hover:text-blue-500 hover:bg-blue-50 transition-colors duration-150 shrink-0"
              title="View all sections in this group"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
          </div>
          {viewingGroup && (
            <GroupViewer
              sectionIds={collectIds(node)}
              title={node.label}
              onClose={() => setViewingGroup(false)}
            />
          )}
        </>
      )}
      {!collapsed && (
        <>
          {/* Render child groups first */}
          {Array.from(node.children.entries()).map(([key, child]) => (
            <SectionTreeGroup
              key={key}
              node={child}
              depth={depth + 1}
              treeName={treeName}
              selectedSectionId={selectedSectionId}
              onSelectSection={onSelectSection}
              onViewSection={onViewSection}
              renderSubtitle={renderSubtitle}
              onSectionMoved={onSectionMoved}
              onSelectGroup={onSelectGroup}
            />
          ))}
          {/* Then orphan sections (no deeper group) at the end */}
          {node.sections.map((section) => (
            <div
              key={section.id}
              onClick={() => onSelectSection(section)}
              className={`flex items-center gap-2 pl-3 pr-2 py-1 cursor-pointer transition-colors duration-150 ${
                selectedSectionId === section.id
                  ? 'bg-blue-50 text-blue-700'
                  : 'hover:bg-gray-50 text-gray-700'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  section.section_status === 'green'
                    ? 'bg-green-400'
                    : section.section_status === 'orange'
                    ? 'bg-orange-400'
                    : section.is_verified
                    ? 'bg-green-400'
                    : (section.flags?.length ?? 0) > 0
                    ? 'bg-amber-400'
                    : 'bg-gray-300'
                }`}
              />
              <div className="flex-1 min-w-0">
                <span className={`text-xs truncate block ${
                  section.section_status === 'green' ? 'text-green-600' :
                  section.section_status === 'orange' ? 'text-orange-500' :
                  ''
                }`}>
                  {section.is_done && (
                    <svg className="inline-block h-3 w-3 mr-0.5 -mt-0.5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                  {section.heading}
                </span>
                <span className="text-[9px] text-gray-400 truncate block leading-tight">
                  {renderSubtitle ? renderSubtitle(section) : (section.curriculum_topic_path ?? `${treeName} › ${section.heading}`)}
                </span>
              </div>
              {section.card_count > 0 && (
                <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
                  {section.card_count}
                </span>
              )}
              {onSectionMoved && !section.curriculum_topic_path?.includes(' > ') && (
                <RepositionButton sectionId={section.id} sectionHeading={section.heading} onDone={onSectionMoved} />
              )}
              <ViewSectionButton onView={() => onViewSection(section.id)} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ── RepositionButton: pick parent → create leaf + map section in one step ─────

function RepositionButton({ sectionId, sectionHeading, onDone }: { sectionId: number; sectionHeading: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [nodes, setNodes] = useState<CurriculumNode[]>([]);
  const [parentId, setParentId] = useState<number | null>(null);
  const [leafName, setLeafName] = useState(sectionHeading);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && nodes.length === 0) {
      getCurriculum('v1').then(setNodes).catch(() => {});
    }
  }, [open, nodes.length]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSubmit = async () => {
    if (!parentId || !leafName.trim()) return;
    setSaving(true);
    try {
      const node = await createCurriculumNode({ name: leafName.trim(), parent_id: parentId });
      await updateSection(sectionId, { curriculum_topic_id: node.id, curriculum_topic_path: node.path });
      setOpen(false);
      onDone();
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="p-1 rounded text-gray-300 hover:text-indigo-500 hover:bg-indigo-50 transition-colors duration-150"
        title="Reposition section under a curriculum topic"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl z-50 p-3 w-72" onClick={(e) => e.stopPropagation()}>
          <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-2">Move to curriculum topic</p>
          <CurriculumPicker
            flatNodes={nodes}
            value={parentId}
            onChange={setParentId}
            placeholder="Select parent topic..."
          />
          <div className="mt-2">
            <label className="text-[10px] text-gray-500">Leaf name</label>
            <input
              type="text"
              value={leafName}
              onChange={(e) => setLeafName(e.target.value)}
              className="w-full px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:border-blue-500 mt-0.5"
            />
          </div>
          <div className="mt-2 flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={saving || !parentId || !leafName.trim()}
              className="px-3 py-1 rounded text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Moving...' : 'Move'}
            </button>
            <button onClick={() => setOpen(false)} className="px-3 py-1 rounded text-xs font-medium bg-gray-100 text-gray-600">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── GroupViewer: read-only modal showing all sections in a group as one doc ───

function GroupViewer({ sectionIds, title, onClose }: { sectionIds: number[]; title: string; onClose: () => void }) {
  const [sections, setSections] = useState<SectionDetail[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all(sectionIds.map(id => getSection(id))).then(results => {
      if (!cancelled) { setSections(results); setLoading(false); }
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sectionIds]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-[90vw] max-w-4xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 shrink-0">
          <h2 className="text-sm font-semibold text-gray-800 truncate">{title}</h2>
          <span className="text-[10px] text-gray-400 mr-2">{sectionIds.length} sections</span>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <p className="text-sm text-gray-400 text-center py-8">Loading sections...</p>
          ) : sections.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No sections found</p>
          ) : (
            <div className="prose prose-sm max-w-none">
              {sections.map((s, i) => (
                <div key={s.id} className={i > 0 ? 'mt-8 pt-6 border-t border-gray-200' : ''}>
                  <h2 className="text-base font-bold text-gray-800 mb-1">{s.heading}</h2>
                  {s.curriculum_topic_path && (
                    <p className="text-[10px] text-gray-400 mb-3">{s.curriculum_topic_path}</p>
                  )}
                  <div className="section-content" dangerouslySetInnerHTML={{ __html: s.content_html || s.content_text || '' }} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ViewSectionButton: padded eye icon button for viewing section content ─────

function ViewSectionButton({ onView }: { onView: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onView(); }}
      className="p-1.5 rounded text-gray-300 hover:text-blue-500 hover:bg-blue-50 transition-colors duration-150 shrink-0"
      title="View section content"
    >
      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </svg>
    </button>
  );
}

// ── Curriculum expansion config (passed through the recursive TopicNode tree) ─

interface CurriculumExpansionConfig {
  expandedPath: string | null;
  sections: CurriculumSection[];
  loading: boolean;
  onPreview: (path: string) => void;
  onViewSection: (id: number) => void;

  onGenerationDone: () => void;
  refreshUsage: () => void;
  selectedModel: string;
  selectedRuleSetId: number | null;
}

// ── CurriculumActionBar: estimate / preview / generate for a curriculum node ──

interface CurriculumActionBarProps {
  sections: CurriculumSection[];
  loading: boolean;
  expandedPath: string;
  onPreview: () => void;
  onViewSection: (id: number) => void;

  onGenerationDone: () => void;
  refreshUsage: () => void;
  selectedModel: string;
  selectedRuleSetId: number | null;
}

function CurriculumActionBar({
  sections, loading, expandedPath, onPreview, onViewSection, onGenerationDone, refreshUsage, selectedModel, selectedRuleSetId,
}: CurriculumActionBarProps) {
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [jobProgress, setJobProgress] = useState<{ processed: number; total: number } | null>(null);
  const [showSections, setShowSections] = useState(false);
  const [genVTC, setGenVTC] = useState(false);
  const [vtcProgress, setVtcProgress] = useState<{ processed: number; total: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const vtcPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (vtcPollRef.current) clearInterval(vtcPollRef.current);
  }, []);

  // Reset state when expanded path changes
  useEffect(() => { setEstimate(null); setJobProgress(null); setShowSections(false); }, [expandedPath]);

  const sectionIds = sections.map(s => s.id);

  const handleEstimate = async () => {
    if (!selectedRuleSetId || !selectedModel || sectionIds.length === 0) return;
    setEstimating(true);
    setEstimate(null);
    try {
      const result = await estimateCost({ section_ids: sectionIds, rule_set_id: selectedRuleSetId, model: selectedModel });
      setEstimate(result);
    } catch { /* ignore */ } finally { setEstimating(false); }
  };

  const handleGenerate = async () => {
    if (!selectedRuleSetId || !selectedModel || sectionIds.length === 0 || generating) return;
    setGenerating(true);
    setJobProgress(null);
    try {
      const { job_id } = await startGeneration({ section_ids: sectionIds, rule_set_id: selectedRuleSetId, model: selectedModel });
      pollRef.current = setInterval(async () => {
        try {
          const job = await getGenerationJob(job_id);
          setJobProgress({ processed: job.processed_sections, total: job.total_sections });
          if (job.status === 'done' || job.status === 'failed') {
            clearInterval(pollRef.current!); pollRef.current = null;
            setGenerating(false);
            onGenerationDone();
            refreshUsage();
          }
        } catch { clearInterval(pollRef.current!); pollRef.current = null; setGenerating(false); }
      }, 1500);
    } catch { setGenerating(false); }
  };

  // Generate vignettes + teaching cases for every card in these sections that
  // doesn't already have them (replace_existing: false → skips cards that have
  // both, so a second click only fills in the gaps). Saves select-all + Actions.
  const handleGenVTC = async () => {
    if (!selectedModel || sectionIds.length === 0 || genVTC) return;
    setGenVTC(true);
    setVtcProgress(null);
    try {
      const { job_id } = await startSupplemental({
        section_ids: sectionIds,
        model: selectedModel,
        replace_existing: false,
      });
      vtcPollRef.current = setInterval(async () => {
        try {
          const job = await getGenerationJob(job_id);
          setVtcProgress({ processed: job.processed_sections, total: job.total_sections });
          if (job.status === 'done' || job.status === 'failed') {
            clearInterval(vtcPollRef.current!); vtcPollRef.current = null;
            setGenVTC(false);
            onGenerationDone();
            refreshUsage();
          }
        } catch { clearInterval(vtcPollRef.current!); vtcPollRef.current = null; setGenVTC(false); }
      }, 1500);
    } catch { setGenVTC(false); }
  };

  if (loading) {
    return <div className="px-3 py-2 text-xs text-gray-400 italic">Loading sections…</div>;
  }
  if (sections.length === 0) {
    return <div className="px-3 py-2 text-xs text-gray-400 italic">No sections mapped to this topic</div>;
  }

  // Sort: leaf-matched sections first, orphans (path === expandedPath) at bottom
  const sortedSections = [...sections].sort((a, b) => {
    const aOrphan = a.curriculum_topic_path === expandedPath;
    const bOrphan = b.curriculum_topic_path === expandedPath;
    if (aOrphan !== bOrphan) return aOrphan ? 1 : -1;
    return (a.curriculum_topic_path ?? '').localeCompare(b.curriculum_topic_path ?? '');
  });
  const hasDeepSections = sections.some(s => (s.curriculum_topic_path ?? '').startsWith(expandedPath + ' > '));

  return (
    <>
      {/* Action bar */}
      <div className="px-2 py-1.5 bg-slate-50 border-b border-slate-100 flex items-center gap-1 flex-wrap">
        <span className="text-[10px] text-gray-400">{sections.length} section{sections.length !== 1 ? 's' : ''}</span>
        <button onClick={onPreview} className="px-1.5 py-0.5 text-[10px] font-medium text-gray-600 bg-white border border-gray-200 rounded hover:bg-gray-50">
          Preview
        </button>
        <button
          onClick={handleEstimate}
          disabled={estimating || !selectedRuleSetId}
          className="px-1.5 py-0.5 text-[10px] font-medium text-gray-600 bg-white border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50"
        >
          {estimating ? '…' : 'Estimate'}
        </button>
        {estimate && (
          <span className="text-[10px] text-blue-700 font-medium">~${estimate.estimated_cost_usd.toFixed(3)}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={handleGenerate}
            disabled={generating || !selectedRuleSetId}
            className="px-1.5 py-0.5 text-[10px] font-medium text-white bg-blue-700 rounded hover:bg-blue-800 disabled:opacity-50"
          >
            {generating
              ? (jobProgress ? `${jobProgress.processed}/${jobProgress.total}` : 'Starting…')
              : 'Generate'}
          </button>
          <button
            onClick={handleGenVTC}
            disabled={genVTC || !selectedModel || sectionIds.length === 0}
            title="Generate vignettes + teaching cases for cards in these sections that don't have them yet"
            className="px-1.5 py-0.5 text-[10px] font-medium text-white bg-violet-600 rounded hover:bg-violet-700 disabled:opacity-50"
          >
            {genVTC
              ? (vtcProgress ? `V+TC ${vtcProgress.processed}/${vtcProgress.total}` : 'V+TC…')
              : 'Gen V+TC'}
          </button>
          <button
            onClick={() => setShowSections(v => !v)}
            className="p-0.5 text-gray-400 hover:text-gray-600 border border-gray-200 rounded bg-white"
            title={showSections ? 'Hide sections' : 'Show sections'}
          >
            <svg className={`h-3 w-3 transition-transform duration-150 ${showSections ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Section list — grouped tree, collapsed by default */}
      {showSections && (
        <SectionTreeGroup
          node={buildSectionTree(sortedSections, expandedPath.split(' > ').pop() || '', expandedPath)}
          depth={0}
          treeName={expandedPath}
          selectedSectionId={null}
          onSelectSection={() => {}}
          onViewSection={onViewSection}
          renderSubtitle={(s) => {
            const isOrphan = hasDeepSections && s.curriculum_topic_path === expandedPath;
            return (
              <>
                {isOrphan && <span className="text-amber-600 font-medium">No leaf · </span>}
                {(s as CurriculumSection).topic_tree_name}
              </>
            );
          }}
        />
      )}
    </>
  );
}

// ── TopicNodeProps / TopicNode ─────────────────────────────────────────────────

interface TopicNodeProps {
  node: CurriculumNode;
  depth: number;
  onSelect: (id: number) => void;
  selectedId: number | null;
  selectedAncestorIds: Set<number>;
  cardCounts: Record<string, TopicCoverageStats>;
  expansion: CurriculumExpansionConfig;
}

// Roll up section done/total over a topic and all its descendants for the topic ✓.
function subtreeSectionsDone(node: CurriculumNode, cardCounts: Record<string, TopicCoverageStats>): { total: number; done: number } {
  const s = cardCounts[String(node.id)];
  let total = s?.sections_total ?? 0;
  let done = s?.sections_done ?? 0;
  for (const ch of node.children) {
    const r = subtreeSectionsDone(ch, cardCounts);
    total += r.total; done += r.done;
  }
  return { total, done };
}

function TopicNode({ node, depth, onSelect, selectedId, selectedAncestorIds, cardCounts, expansion }: TopicNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const stats = cardCounts[String(node.id)];
  const _sd = subtreeSectionsDone(node, cardCounts);
  const allSectionsDone = _sd.total > 0 && _sd.done === _sd.total;
  const active = stats?.active ?? 0;
  const unreviewed = stats?.unreviewed ?? 0;
  const reviewed = active - unreviewed;
  const isSelected = node.id === selectedId;
  const isAncestor = selectedAncestorIds.has(node.id);
  const levelBadge = TOPIC_LEVEL_BADGE[Math.min(node.level, 3)];
  const isCurriculumExpanded = expansion.expandedPath === node.path;

  return (
    <div>
      <div
        onClick={() => onSelect(node.id)}
        className={[
          'flex items-center gap-1.5 py-1.5 rounded-lg mx-1 cursor-pointer transition-colors duration-150',
          isSelected ? 'bg-blue-100 text-blue-800' : isAncestor ? 'bg-blue-50 text-blue-700 hover:bg-blue-100' : 'hover:bg-gray-50',
        ].join(' ')}
        style={{ paddingLeft: `${8 + depth * 14}px`, paddingRight: '8px' }}
      >
        {node.children.length > 0 ? (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            className="shrink-0 text-gray-400 hover:text-gray-600 transition-colors duration-150"
          >
            <svg className={`h-3 w-3 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className={`text-[9px] font-bold w-4 text-center rounded shrink-0 py-px ${levelBadge}`}>{node.level}</span>
        <span className={`flex-1 text-xs truncate ${isSelected ? 'font-semibold' : 'font-medium'} ${active === 0 && !isSelected && !isAncestor ? 'text-gray-400' : ''}`}>
          {allSectionsDone && (
            <svg className="inline-block h-3 w-3 mr-0.5 -mt-0.5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
          {node.name}
        </span>
        {active > 0 && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 font-semibold tabular-nums ${isSelected ? 'bg-blue-200 text-blue-800' : unreviewed === 0 ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-700'}`}>
            {reviewed}/{active}
          </span>
        )}
        {/* Curriculum sections toggle indicator */}
        {isCurriculumExpanded && (
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0 ml-0.5" />
        )}
      </div>

      {/* Curriculum sections panel — expands when this node is selected */}
      {isCurriculumExpanded && (
        <div className="ml-3 mr-1 mb-1 border border-blue-100 rounded-lg overflow-hidden bg-white">
          <CurriculumActionBar
            sections={expansion.sections}
            loading={expansion.loading}
            expandedPath={node.path}
            onPreview={() => expansion.onPreview(node.path)}
            onViewSection={expansion.onViewSection}

            onGenerationDone={expansion.onGenerationDone}
            refreshUsage={expansion.refreshUsage}
            selectedModel={expansion.selectedModel}
            selectedRuleSetId={expansion.selectedRuleSetId}
          />
        </div>
      )}

      {expanded && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TopicNode
              key={child.id}
              node={child}
              depth={depth + 1}
              onSelect={onSelect}
              selectedId={selectedId}
              selectedAncestorIds={selectedAncestorIds}
              cardCounts={cardCounts}
              expansion={expansion}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Search result node — shows ancestors dimmed, matches bold
interface TopicSearchNodeProps {
  node: CurriculumNode;
  matchIds: Set<number>;
  ancestorIds: Set<number>;
  onSelect: (id: number) => void;
  selectedId: number | null;
  cardCounts: Record<string, TopicCoverageStats>;
}

function TopicSearchNode({ node, matchIds, ancestorIds, onSelect, selectedId, cardCounts }: TopicSearchNodeProps) {
  const isMatch = matchIds.has(node.id);
  const isAncestor = ancestorIds.has(node.id);
  if (!isMatch && !isAncestor) return null;

  const isSelected = node.id === selectedId;
  const stats = cardCounts[String(node.id)] ?? { active: 0, unreviewed: 0 };
  const reviewed = stats.active - stats.unreviewed;
  const isDimmed = isAncestor && !isMatch;
  const levelBadge = TOPIC_LEVEL_BADGE[Math.min(node.level, 3)];

  return (
    <div>
      <div
        onClick={() => !isDimmed && onSelect(node.id)}
        className={[
          'flex items-center gap-1.5 py-1.5 rounded-lg mx-1 transition-colors duration-150',
          isDimmed ? 'cursor-default' : 'cursor-pointer',
          isSelected ? 'bg-blue-100 text-blue-800' : isDimmed ? 'hover:bg-gray-50' : 'hover:bg-gray-50',
        ].join(' ')}
        style={{ paddingLeft: `${8 + node.level * 14}px`, paddingRight: '8px' }}
      >
        <span className={`text-[9px] font-bold w-4 text-center rounded shrink-0 py-px ${levelBadge}`}>{node.level}</span>
        <span className={`flex-1 text-xs truncate ${isDimmed ? 'text-gray-400' : isSelected ? 'font-semibold text-blue-800' : 'font-semibold text-gray-800'}`}>{node.name}</span>
        {!isDimmed && stats.active > 0 && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 font-semibold tabular-nums ${stats.unreviewed === 0 ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-700'}`}>
            {reviewed}/{stats.active}
          </span>
        )}
      </div>
      {node.children.map((child) => (
        <TopicSearchNode key={child.id} node={child} matchIds={matchIds} ancestorIds={ancestorIds} onSelect={onSelect} selectedId={selectedId} cardCounts={cardCounts} />
      ))}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

interface WorkspacePageProps {
  refreshUsage: () => void;
}

export default function WorkspacePage({ refreshUsage }: WorkspacePageProps) {
  const { curriculumVersion, selectedModel, selectedRuleSetId } = useSettings();

  // Sidebar tab
  const [sidebarTab, setSidebarTab] = useState<'documents' | 'topics'>('documents');

  // Sidebar collapse & width (persisted to localStorage)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    localStorage.getItem('ws_sidebar_collapsed') === 'true'
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('ws_sidebar_width');
    return saved ? Math.max(250, Math.min(550, parseInt(saved, 10))) : 350;
  });

  // Topic trees (documents)
  const [topicTrees, setTopicTrees] = useState<TopicTree[]>([]);
  const [expandedTreeId, setExpandedTreeId] = useState<number | null>(null);
  const [expandedTree, setExpandedTree] = useState<TopicTree | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(null);
  const [selectedSectionIds, setSelectedSectionIds] = useState<number[] | null>(null);
  const [, setSelectedSection] = useState<Section | null>(null);

  // Curriculum
  const [curriculum, setCurriculum] = useState<CurriculumNode[]>([]);
  const [cardCounts, setCardCounts] = useState<Record<string, TopicCoverageStats>>({});
  const [selectedTopicId, setSelectedTopicId] = useState<number | null>(null);
  const [selectedTopicPath, setSelectedTopicPath] = useState<string | null>(null);

  // Upload
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [processingJobId, setProcessingJobId] = useState<number | null>(null);
  const [processingStep, setProcessingStep] = useState<string | null>(null);
  const [reconcile, setReconcile] = useState<{ uploadId: number; diff: ReconcileDiff } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Section viewer
  const [viewingSectionId, setViewingSectionId] = useState<number | null>(null);

  // Paste modal
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [pastedHtml, setPastedHtml] = useState<string | null>(null);
  const [pasteName, setPasteName] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteCurriculumId, setPasteCurriculumId] = useState<number | null>(null);
  const pasteAreaRef = useRef<HTMLDivElement>(null);
  const [pasteTargetTreeId, setPasteTargetTreeId] = useState<number | null>(null);

  // Upload modal
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadCurriculumId, setUploadCurriculumId] = useState<number | null>(null);

  // Delete confirm
  const [confirmDelete, setConfirmDelete] = useState<{ id: number; name: string } | null>(null);

  // Curriculum sections expansion (Topics tab)
  const [expandedCurriculumPath, setExpandedCurriculumPath] = useState<string | null>(null);
  const [curriculumSections, setCurriculumSections] = useState<CurriculumSection[]>([]);
  const [curriculumSectionsLoading, setCurriculumSectionsLoading] = useState(false);
  const [previewCurriculumPath, setPreviewCurriculumPath] = useState<string | null>(null);

  // Refresh key for cards panel
  const [refreshKey, setRefreshKey] = useState(0);

  // Active generation jobs (for badges + resume after refresh)
  const [activeGenJobs, setActiveGenJobs] = useState<Record<number, GenerationJob>>({});
  const genPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll active generation jobs
  useEffect(() => {
    const pollActiveJobs = async () => {
      try {
        const jobs = await getActiveJobs();
        const byTree: Record<number, GenerationJob> = {};
        for (const j of jobs) {
          if (j.topic_tree_id) byTree[j.topic_tree_id] = j;
        }
        setActiveGenJobs(byTree);
        // If no more active jobs, stop polling
        if (jobs.length === 0 && genPollRef.current) {
          clearInterval(genPollRef.current);
          genPollRef.current = null;
          loadTopicTrees();
          loadCurriculum();
          setRefreshKey(k => k + 1);
          refreshUsage();
        }
      } catch { /* ignore */ }
    };
    // Initial check
    pollActiveJobs();
    // Start polling interval
    genPollRef.current = setInterval(pollActiveJobs, 3000);
    return () => { if (genPollRef.current) clearInterval(genPollRef.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load topic trees
  const loadTopicTrees = useCallback(async () => {
    try {
      const trees = await getTopicTrees();
      setTopicTrees(trees);
    } catch { /* ignore */ }
  }, []);

  // Load curriculum
  const loadCurriculum = useCallback(async () => {
    try {
      const [tree, coverage] = await Promise.all([getCurriculum(curriculumVersion), getCurriculumCoverage(curriculumVersion)]);
      setCurriculum(tree);
      setCardCounts(buildAggregatedCounts(tree, coverage));
    } catch { /* ignore */ }
  }, [curriculumVersion]);

  useEffect(() => {
    loadTopicTrees();
    loadCurriculum();
  }, [loadTopicTrees, loadCurriculum]);

  // Expand topic tree to load sections
  const expandTree = useCallback(async (id: number) => {
    if (expandedTreeId === id) {
      setExpandedTreeId(null);
      setExpandedTree(null);
      setSelectedSectionId(null);
      setSelectedSection(null);
      return;
    }
    try {
      const tree = await getTopicTree(id);
      setExpandedTreeId(id);
      setExpandedTree(tree);
    } catch { /* ignore */ }
  }, [expandedTreeId]);

  // Select section — clears topic selection + curriculum expansion
  const selectSection = useCallback((section: Section) => {
    setSelectedSectionId(section.id);
    setSelectedSection(section);
    setSelectedSectionIds(null);
    setSelectedTopicId(null);
    setSelectedTopicPath(null);
    setExpandedCurriculumPath(null);
    setCurriculumSections([]);
    setSidebarTab('documents');
  }, []);

  // Flat curriculum — must be declared before selectTopic which references it
  const flatCurriculum = useMemo(() => flattenCurriculum(curriculum), [curriculum]);

  // Select topic — loads curriculum sections, toggles expansion on re-click
  const selectTopic = useCallback(async (id: number) => {
    const node = flatCurriculum.find((n) => n.id === id);
    const path = node?.path ?? null;
    setSelectedTopicId(id);
    setSelectedTopicPath(path);
    setSelectedSectionId(null);
    setSelectedSection(null);
    setTopicSearch('');

    if (!path) return;

    // Toggle off if same node clicked again
    if (expandedCurriculumPath === path) {
      setExpandedCurriculumPath(null);
      setCurriculumSections([]);
      return;
    }

    setExpandedCurriculumPath(path);
    setCurriculumSectionsLoading(true);
    setCurriculumSections([]);
    try {
      const secs = await getSectionsByCurriculum(path);
      setCurriculumSections(secs);
    } catch { /* ignore */ } finally {
      setCurriculumSectionsLoading(false);
    }
  }, [flatCurriculum, expandedCurriculumPath]);

  // (flatCurriculum is declared above selectTopic to avoid temporal dead zone)

  // Upload handler
  const handleUploadConfirm = useCallback(async () => {
    if (!uploadFile) return;
    setShowUploadModal(false);
    setUploading(true);
    setUploadError(null);
    try {
      const result = await uploadDocument(uploadFile, {
        topicTreeId: expandedTreeId ?? undefined,
        topicTreeName: uploadName || undefined,
        curriculumId: uploadCurriculumId ?? undefined,
      });
      if (result.reconcile) {
        // Curriculum-aligned flow: job is parked at the reconcile gate.
        setReconcile({ uploadId: result.upload_id, diff: result.reconcile });
        setUploadFile(null);
        setUploading(false);
        return;  // do NOT setProcessingJobId — job is parked
      }
      // Legacy/paste path fallback
      setProcessingJobId(result.processing_job_id);
      setUploadFile(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setUploadError(msg);
      setUploading(false);
    }
  }, [uploadFile, expandedTreeId, uploadName, uploadCurriculumId]);

  // Poll processing job
  useEffect(() => {
    if (processingJobId == null) return;
    const interval = setInterval(async () => {
      try {
        const job = await getProcessingJob(processingJobId);
        setProcessingStep(job.pipeline_step);
        if (job.status === 'done' || job.status === 'failed') {
          clearInterval(interval);
          setProcessingJobId(null);
          setUploading(false);
          if (job.status === 'failed') {
            setUploadError(job.error_message ?? 'Processing failed');
          } else {
            loadTopicTrees();
            const treeToExpand = pasteTargetTreeId ?? expandedTreeId;
            if (treeToExpand) expandTree(treeToExpand);
            setPasteTargetTreeId(null);
          }
          refreshUsage();
        }
      } catch {
        clearInterval(interval);
        setProcessingJobId(null);
        setUploading(false);
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [processingJobId, loadTopicTrees, expandedTreeId, expandTree, refreshUsage, pasteTargetTreeId]);

  // Delete topic tree
  const handleDeleteTree = useCallback(async () => {
    if (!confirmDelete) return;
    try {
      await deleteTopicTree(confirmDelete.id);
      setConfirmDelete(null);
      if (expandedTreeId === confirmDelete.id) {
        setExpandedTreeId(null);
        setExpandedTree(null);
        setSelectedSectionId(null);
        setSelectedSection(null);
      }
      loadTopicTrees();
    } catch { /* ignore */ }
  }, [confirmDelete, expandedTreeId, loadTopicTrees]);

  // Topics sidebar state
  const [topicSearch, setTopicSearch] = useState('');
  const [topicSort, setTopicSort] = useState<'curriculum' | 'alpha'>('curriculum');

  const sortedCurriculum = useMemo(() => sortTree(curriculum, topicSort), [curriculum, topicSort]);

  // Flat curriculum for search
  const flatCurriculumForSearch = useMemo(() => flattenCurriculum(curriculum), [curriculum]);

  // parentMap for ancestor lookups
  const parentMap = useMemo(() => {
    const m = new Map<number, number | null>();
    for (const n of flatCurriculumForSearch) m.set(n.id, n.parent_id ?? null);
    return m;
  }, [flatCurriculumForSearch]);

  // Ancestors of the currently selected topic — for persistent highlight
  const selectedAncestorIds = useMemo(() => {
    if (selectedTopicId == null) return new Set<number>();
    const ancestors = new Set<number>();
    let cur = parentMap.get(selectedTopicId) ?? null;
    while (cur != null) {
      ancestors.add(cur);
      cur = parentMap.get(cur) ?? null;
    }
    return ancestors;
  }, [selectedTopicId, parentMap]);

  // Search: matchIds + ancestorIds for tree-aware results
  const { topicMatchIds, topicAncestorIds } = useMemo(() => {
    if (!topicSearch.trim()) return { topicMatchIds: null, topicAncestorIds: new Set<number>() };
    const q = topicSearch.toLowerCase();
    const matches = new Set<number>();
    for (const n of flatCurriculumForSearch) {
      if (n.name.toLowerCase().includes(q)) matches.add(n.id);
    }
    const ancestors = new Set<number>();
    for (const id of matches) {
      let cur = parentMap.get(id) ?? null;
      while (cur != null) { ancestors.add(cur); cur = parentMap.get(cur) ?? null; }
    }
    return { topicMatchIds: matches, topicAncestorIds: ancestors };
  }, [topicSearch, flatCurriculumForSearch, parentMap]);

  // Open paste modal
  const openPasteModal = useCallback(() => {
    setPastedHtml(null);
    setPasteName('');
    setPasteError(null);
    setPasteCurriculumId(null);
    setShowPasteModal(true);
    setTimeout(() => pasteAreaRef.current?.focus(), 50);
  }, []);

  // Handle paste event in modal
  const handlePasteEvent = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    const content = html || text;
    if (!content.trim()) return;
    setPastedHtml(content);
    // Auto-detect name from first heading
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/html');
    const heading = doc.querySelector('h1, h2, h3, h4, b, strong');
    if (heading?.textContent && !pasteName) {
      setPasteName(heading.textContent.slice(0, 100).trim());
    }
  }, [pasteName]);

  // Submit paste
  const handlePasteSubmit = useCallback(async () => {
    if (!pastedHtml || !pasteName.trim()) return;
    setShowPasteModal(false);
    setUploading(true);
    setUploadError(null);
    try {
      const result = await pasteDocument(pastedHtml, pasteName.trim(), {
        topicTreeId: expandedTreeId ?? undefined,
        curriculumId: pasteCurriculumId ?? undefined,
      });
      setProcessingJobId(result.processing_job_id);
      setPasteTargetTreeId(result.topic_tree_id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Paste failed';
      setUploadError(msg);
      setUploading(false);
    }
  }, [pastedHtml, pasteName, expandedTreeId, pasteCurriculumId]);

  function toggleSidebar() {
    setSidebarCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('ws_sidebar_collapsed', String(next));
      return next;
    });
  }

  function onDragHandleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    function onMove(ev: MouseEvent) {
      const next = Math.max(250, Math.min(550, startW + ev.clientX - startX));
      setSidebarWidth(next);
      localStorage.setItem('ws_sidebar_width', String(Math.round(next)));
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Sidebar */}
      <div
        className="bg-white border-r border-gray-200 flex flex-col shrink-0 relative"
        style={{ width: sidebarCollapsed ? 36 : sidebarWidth }}
      >
        {sidebarCollapsed ? (
          <div className="flex flex-col items-center py-2">
            <button
              onClick={toggleSidebar}
              title="Expand sidebar"
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        ) : (
          <>
        {/* Upload area */}
        <div className="p-3 border-b border-gray-100">
          <div className="flex gap-1.5">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex-1 px-3 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors duration-150"
            >
              {uploading ? (processingStep ?? 'Processing...') : 'Upload .docx'}
            </button>
            <button
              onClick={openPasteModal}
              disabled={uploading}
              className="px-3 py-2 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors duration-150"
            >
              Paste
            </button>
            <button
              onClick={toggleSidebar}
              title="Collapse sidebar"
              className="px-2 py-2 text-gray-400 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:text-gray-600 transition-colors duration-150"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setUploadFile(f);
                setUploadName(f.name.replace(/\.docx$/i, ''));
                setUploadCurriculumId(null);
                setShowUploadModal(true);
              }
              e.target.value = '';
            }}
          />
          {uploadError && (
            <p className="text-xs text-red-600 mt-1.5">{uploadError}</p>
          )}
        </div>

        {/* Sidebar tabs */}
        <div className="flex border-b border-gray-100">
          <button
            onClick={() => setSidebarTab('documents')}
            className={`flex-1 px-3 py-2 text-xs font-medium transition-colors duration-150 ${
              sidebarTab === 'documents'
                ? 'text-blue-700 border-b-2 border-blue-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Documents
          </button>
          <button
            onClick={() => setSidebarTab('topics')}
            className={`flex-1 px-3 py-2 text-xs font-medium transition-colors duration-150 ${
              sidebarTab === 'topics'
                ? 'text-blue-700 border-b-2 border-blue-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Topics
          </button>
        </div>

        {/* Sidebar content */}
        <div className="flex-1 overflow-y-auto">
          {sidebarTab === 'documents' ? (
            <div className="py-1">
              {topicTrees.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-8">No documents yet</p>
              ) : (
                topicTrees.map((tree) => (
                  <div key={tree.id}>
                    <div
                      className={`group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors duration-150 ${
                        expandedTreeId === tree.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                      }`}
                      onClick={() => expandTree(tree.id)}
                    >
                      <svg
                        className={`h-3 w-3 text-gray-400 transition-transform duration-150 shrink-0 ${
                          expandedTreeId === tree.id ? 'rotate-90' : ''
                        }`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2.5}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-gray-800 truncate block">
                          {tree.name}
                          {activeGenJobs[tree.id] && (
                            <span className="ml-1.5 inline-flex items-center gap-1 text-[10px] text-blue-600 font-normal">
                              <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
                              {activeGenJobs[tree.id].pipeline_step ?? 'generating'}
                            </span>
                          )}
                        </span>
                        <span className="text-[10px] text-gray-400">
                          {tree.section_count} sections &middot; {tree.total_cards} cards
                        </span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete({ id: tree.id, name: tree.name });
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 text-gray-300 hover:text-red-500 transition-all duration-150"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m-7 0a1 1 0 01-1-1V5a1 1 0 011-1h6a1 1 0 011 1v1a1 1 0 01-1 1H9z" />
                        </svg>
                      </button>
                    </div>

                    {/* Sections — grouped by curriculum path */}
                    {expandedTreeId === tree.id && expandedTree?.sections && (
                      <div className="ml-5">
                        <SectionTreeGroup
                          node={buildSectionTree(expandedTree.sections, expandedTree.name)}
                          depth={0}
                          treeName={expandedTree.name}
                          selectedSectionId={selectedSectionId}
                          onSelectSection={selectSection}
                          onViewSection={setViewingSectionId}
                          onSectionMoved={() => expandTree(tree.id)}
                          onSelectGroup={(ids) => {
                            setSelectedSectionId(null);
                            setSelectedSection(null);
                            setSelectedTopicPath(null);
                            setSelectedSectionIds(ids);
                          }}
                        />
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="flex flex-col h-full">
              {/* Search + sort toolbar */}
              <div className="px-2 pt-2 pb-1.5 border-b border-gray-100 shrink-0 space-y-1.5">
                <div className="relative">
                  <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
                  </svg>
                  <input
                    type="text"
                    value={topicSearch}
                    onChange={(e) => setTopicSearch(e.target.value)}
                    placeholder="Search topics…"
                    className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-gray-50"
                  />
                  {topicSearch && (
                    <button onClick={() => setTopicSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-end">
                  <button
                    onClick={() => setTopicSort((s) => s === 'curriculum' ? 'alpha' : 'curriculum')}
                    className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-blue-700 font-medium"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                    </svg>
                    {topicSort === 'alpha' ? 'A–Z' : 'Curriculum'}
                  </button>
                </div>
              </div>

              {/* Tree */}
              <div className="flex-1 overflow-y-auto py-1">
                {topicMatchIds !== null ? (
                  topicMatchIds.size === 0 ? (
                    <p className="text-xs text-gray-400 italic px-3 py-4">No matches for "{topicSearch}"</p>
                  ) : (
                    sortedCurriculum.map((node) => (
                      <TopicSearchNode
                        key={node.id}
                        node={node}
                        matchIds={topicMatchIds}
                        ancestorIds={topicAncestorIds}
                        onSelect={selectTopic}
                        selectedId={selectedTopicId}
                        cardCounts={cardCounts}
                      />
                    ))
                  )
                ) : (
                  (() => {
                    const expansion: CurriculumExpansionConfig = {
                      expandedPath: expandedCurriculumPath,
                      sections: curriculumSections,
                      loading: curriculumSectionsLoading,
                      onPreview: setPreviewCurriculumPath,
                      onViewSection: setViewingSectionId,
                      onGenerationDone: () => { loadCurriculum(); setRefreshKey(k => k + 1); },
                      refreshUsage,
                      selectedModel,
                      selectedRuleSetId,
                    };
                    return sortedCurriculum.map((node) => (
                      <TopicNode
                        key={node.id}
                        node={node}
                        depth={0}
                        onSelect={selectTopic}
                        selectedId={selectedTopicId}
                        selectedAncestorIds={selectedAncestorIds}
                        cardCounts={cardCounts}
                        expansion={expansion}
                      />
                    ));
                  })()
                )}
              </div>
            </div>
          )}
        </div>
          {/* Drag resize handle */}
          <div
            onMouseDown={onDragHandleMouseDown}
            className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-200 transition-colors z-10"
          />
          </>
        )}
      </div>

      {/* Main panel */}
      <div className="flex-1 overflow-hidden">
        <CardsPanel
          sectionId={selectedSectionId}
          topicPath={selectedTopicPath}
          sectionIds={selectedSectionIds}
          topicTreeId={expandedTreeId}
          refreshKey={refreshKey}
          refreshUsage={refreshUsage}
          onReviewChange={() => {
            setRefreshKey((k) => k + 1);
            loadCurriculum();
            loadTopicTrees();
          }}
        />
      </div>

      {/* Curriculum sections preview modal */}
      {previewCurriculumPath != null && (
        <CurriculumSectionPreview
          expandedPath={previewCurriculumPath}
          sections={curriculumSections}
          onClose={() => setPreviewCurriculumPath(null)}
        />
      )}

      {/* Section viewer modal */}
      {viewingSectionId != null && (
        <SectionViewer
          sectionId={viewingSectionId}
          onClose={() => setViewingSectionId(null)}
        />
      )}

      {/* Curriculum reconcile gate — appears after a curriculum-aligned upload */}
      {reconcile && (
        <ReconcileModal
          uploadId={reconcile.uploadId}
          diff={reconcile.diff}
          onClose={() => setReconcile(null)}
          onContinue={(jobId) => {
            setReconcile(null);
            setUploading(true);
            setProcessingJobId(jobId);
          }}
        />
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <ConfirmModal
          title="Delete Document"
          message={`Delete "${confirmDelete.name}" and all its sections and cards?`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDeleteTree}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {/* Upload modal — pick name + topic before processing */}
      {showUploadModal && uploadFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowUploadModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[480px] overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-sm font-bold text-gray-900">Upload Document</h2>
              <p className="text-xs text-gray-500 mt-0.5">Configure before processing</p>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">File</label>
                <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2">{uploadFile.name}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Document Name</label>
                <input
                  type="text"
                  value={uploadName}
                  onChange={(e) => setUploadName(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Enter a name..."
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Assign to Topic (optional)</label>
                <CurriculumPicker
                  flatNodes={flatCurriculum}
                  value={uploadCurriculumId}
                  onChange={setUploadCurriculumId}
                  placeholder="— no topic —"
                />
                <p className="text-[10px] text-gray-400 mt-1">All sections will inherit this topic for tag generation</p>
              </div>
            </div>
            <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 flex justify-end gap-2">
              <button
                onClick={() => setShowUploadModal(false)}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleUploadConfirm}
                className="px-4 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800"
              >
                Upload & Process
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Paste modal — paste content, preview, pick topic */}
      {showPasteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowPasteModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[900px] max-h-[calc(100vh-48px)] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-200 shrink-0 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-gray-900">Paste Content</h2>
                <p className="text-xs text-gray-500 mt-0.5">Preserves bold, bullets, tables, and images from Word or Google Docs</p>
              </div>
              <button onClick={() => setShowPasteModal(false)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {/* Name + Topic row */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Document Name</label>
                  <input
                    type="text"
                    value={pasteName}
                    onChange={(e) => setPasteName(e.target.value)}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Auto-detected from content..."
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Assign to Topic (optional)</label>
                  <CurriculumPicker
                    flatNodes={flatCurriculum}
                    value={pasteCurriculumId}
                    onChange={setPasteCurriculumId}
                    placeholder="— no topic —"
                  />
                </div>
              </div>

              {/* Paste area / Preview */}
              {!pastedHtml ? (
                <div
                  ref={pasteAreaRef}
                  tabIndex={0}
                  onPaste={handlePasteEvent}
                  className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-text focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-colors min-h-[300px] flex flex-col items-center justify-center gap-3"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <p className="text-sm text-gray-500 font-medium">Click here, then paste</p>
                  <p className="text-xs text-gray-400">Cmd+V / Ctrl+V</p>
                </div>
              ) : (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Preview</span>
                    <button
                      onClick={() => { setPastedHtml(null); setPasteName(''); }}
                      className="text-xs text-gray-500 hover:text-gray-700"
                    >
                      Clear & paste again
                    </button>
                  </div>
                  <div
                    className="border border-gray-200 rounded-xl p-4 max-h-[400px] overflow-y-auto section-content prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: pastedHtml }}
                  />
                </div>
              )}

              {pasteError && (
                <div className="p-3 rounded-lg bg-red-50 text-xs text-red-600">{pasteError}</div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 flex justify-end gap-2 shrink-0">
              <button
                onClick={() => setShowPasteModal(false)}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handlePasteSubmit}
                disabled={!pastedHtml || !pasteName.trim()}
                className="px-4 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50"
              >
                Process & Import
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Helper to flatten curriculum
function flattenCurriculum(nodes: CurriculumNode[]): CurriculumNode[] {
  const result: CurriculumNode[] = [];
  function walk(list: CurriculumNode[]) {
    for (const node of list) {
      result.push(node);
      if (node.children.length > 0) walk(node.children);
    }
  }
  walk(nodes);
  return result;
}
