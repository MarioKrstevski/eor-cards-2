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
} from '../api';
import type { GenerationJob } from '../types';
import type {
  CurriculumNode,
  TopicCoverageStats,
  TopicTree,
  Section,
} from '../types';
import CardsPanel from './CardsPanel';
import SectionViewer from './SectionViewer';
import ConfirmModal from '../components/ConfirmModal';
import CurriculumPicker from '../components/CurriculumPicker';
import { buildAggregatedCounts, sortTree } from '../utils';

// ── TopicNode: read-only collapsible curriculum node for sidebar tree ─────────

interface TopicNodeProps {
  node: CurriculumNode;
  depth: number;
  onSelect: (id: number) => void;
  selectedId: number | null;
  cardCounts: Record<string, TopicCoverageStats>;
}

function topicReviewStyle(active: number, unreviewed: number, isSelected: boolean) {
  if (isSelected) return { text: 'text-blue-700', badge: 'bg-blue-100 text-blue-700' };
  if (active === 0) return { text: 'text-gray-400', badge: '' };
  if (unreviewed === 0) return { text: 'text-green-700', badge: 'bg-green-100 text-green-700' };
  return { text: 'text-blue-600', badge: 'bg-blue-50 text-blue-700' };
}

function TopicNode({ node, depth, onSelect, selectedId, cardCounts }: TopicNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const stats = cardCounts[String(node.id)];
  const active = stats?.active ?? 0;
  const unreviewed = stats?.unreviewed ?? 0;
  const reviewed = active - unreviewed;
  const isSelected = node.id === selectedId;
  const style = topicReviewStyle(active, unreviewed, isSelected);

  return (
    <div>
      <div
        onClick={() => onSelect(node.id)}
        className={[
          'flex items-center gap-1.5 py-1.5 rounded-lg mx-1 cursor-pointer transition-colors duration-150',
          isSelected ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50',
        ].join(' ')}
        style={{ paddingLeft: `${10 + depth * 14}px`, paddingRight: '8px' }}
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
        <span className={`flex-1 text-xs truncate ${isSelected ? 'font-semibold' : 'font-medium'} ${style.text}`}>{node.name}</span>
        {active > 0 && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 font-semibold tabular-nums ${style.badge}`}>
            {reviewed}/{active}
          </span>
        )}
      </div>
      {expanded && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TopicNode
              key={child.id}
              node={child}
              depth={depth + 1}
              onSelect={onSelect}
              selectedId={selectedId}
              cardCounts={cardCounts}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

interface WorkspacePageProps {
  refreshUsage: () => void;
}

export default function WorkspacePage({ refreshUsage }: WorkspacePageProps) {
  // Sidebar tab
  const [sidebarTab, setSidebarTab] = useState<'documents' | 'topics'>('documents');

  // Topic trees (documents)
  const [topicTrees, setTopicTrees] = useState<TopicTree[]>([]);
  const [expandedTreeId, setExpandedTreeId] = useState<number | null>(null);
  const [expandedTree, setExpandedTree] = useState<TopicTree | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(null);
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

  // Upload modal
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadCurriculumId, setUploadCurriculumId] = useState<number | null>(null);

  // Delete confirm
  const [confirmDelete, setConfirmDelete] = useState<{ id: number; name: string } | null>(null);

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
      const [tree, coverage] = await Promise.all([getCurriculum(), getCurriculumCoverage()]);
      setCurriculum(tree);
      setCardCounts(buildAggregatedCounts(tree, coverage));
    } catch { /* ignore */ }
  }, []);

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

  // Select section
  const selectSection = useCallback((section: Section) => {
    setSelectedSectionId(section.id);
    setSelectedSection(section);
    setSelectedTopicId(null);
    setSelectedTopicPath(null);
    setSidebarTab('documents');
  }, []);

  // Select topic
  const selectTopic = useCallback((id: number) => {
    const flat = flattenCurriculum(curriculum);
    const node = flat.find((n) => n.id === id);
    setSelectedTopicId(id);
    setSelectedTopicPath(node?.path ?? null);
    setSelectedSectionId(null);
    setSelectedSection(null);
  }, [curriculum]);

  // Flat curriculum for pickers
  const flatCurriculum = useMemo(() => flattenCurriculum(curriculum), [curriculum]);

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
            if (expandedTreeId) expandTree(expandedTreeId);
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
  }, [processingJobId, loadTopicTrees, expandedTreeId, expandTree, refreshUsage]);

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

  const sortedCurriculum = useMemo(() => sortTree(curriculum, 'curriculum'), [curriculum]);

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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Paste failed';
      setUploadError(msg);
      setUploading(false);
    }
  }, [pastedHtml, pasteName, expandedTreeId, pasteCurriculumId]);

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Sidebar */}
      <div className="w-72 bg-white border-r border-gray-200 flex flex-col shrink-0">
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

                    {/* Sections */}
                    {expandedTreeId === tree.id && expandedTree?.sections && (
                      <div className="ml-5 border-l border-gray-200">
                        {expandedTree.sections.map((section) => (
                          <div
                            key={section.id}
                            onClick={() => selectSection(section)}
                            className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors duration-150 ${
                              selectedSectionId === section.id
                                ? 'bg-blue-50 text-blue-700'
                                : 'hover:bg-gray-50 text-gray-700'
                            }`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                section.is_verified
                                  ? 'bg-green-400'
                                  : (section.flags?.length ?? 0) > 0
                                  ? 'bg-amber-400'
                                  : 'bg-gray-300'
                              }`}
                            />
                            <span className="text-xs truncate flex-1">{section.heading}</span>
                            {section.card_count > 0 && (
                              <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
                                {section.card_count}
                              </span>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setViewingSectionId(section.id);
                              }}
                              className="p-0.5 text-gray-300 hover:text-blue-500 transition-colors duration-150"
                              title="View section content"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              </svg>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="py-1">
              {sortedCurriculum.map((node) => (
                <TopicNode
                  key={node.id}
                  node={node}
                  depth={0}
                  onSelect={selectTopic}
                  selectedId={selectedTopicId}
                  cardCounts={cardCounts}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Main panel */}
      <div className="flex-1 overflow-hidden">
        <CardsPanel
          sectionId={selectedSectionId}
          topicPath={selectedTopicPath}
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

      {/* Section viewer modal */}
      {viewingSectionId != null && (
        <SectionViewer
          sectionId={viewingSectionId}
          onClose={() => setViewingSectionId(null)}
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
