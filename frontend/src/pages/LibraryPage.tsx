import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import ConfirmModal from '../components/ConfirmModal';
import CurriculumPicker from '../components/CurriculumPicker';
import { buildAggregatedCounts, flattenTree, sortTree } from '../utils';
import {
  getCurriculum,
  getCurriculumCoverage,
  createCurriculumNode,
  updateCurriculumNode,
  deleteCurriculumNode,
  getRuleSets,
  createRuleSet,
  updateRuleSet,
  deleteRuleSet,
  setDefaultRuleSet,
  getTopicTrees,
  getTopicTree,
  deleteTopicTree,
  uploadDocument,
  updateSection,
  getProcessingJob,
  exportCardsUrl,
  aiDetectHeadings,
} from '../api';
import type { CurriculumNode, RuleSet, TopicCoverageStats, TopicTree } from '../types';
import { useSettings } from '../context/SettingsContext';

// ─── CurriculumTreeNode (editable, for Curriculum tab) ────────────────────────

interface TreeNodeProps {
  node: CurriculumNode;
  selectedId: number | null;
  onSelect: (node: CurriculumNode) => void;
  onRefresh: () => void;
  onDeleteRequest: (id: number, name: string) => void;
  defaultOpen?: boolean;
}

function CurriculumTreeNode({
  node,
  selectedId,
  onSelect,
  onRefresh,
  onDeleteRequest,
  defaultOpen = false,
}: TreeNodeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [addingChild, setAddingChild] = useState(false);
  const [childName, setChildName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isSelected = node.id === selectedId;
  const hasChildren = node.children.length > 0;

  async function handleRename() {
    if (!renameValue.trim()) return;
    try {
      await updateCurriculumNode(node.id, { name: renameValue.trim() });
      setRenaming(false);
      onRefresh();
    } catch {
      setError('Rename failed');
    }
  }

  async function handleAddChild() {
    if (!childName.trim()) return;
    try {
      await createCurriculumNode({ name: childName.trim(), parent_id: node.id });
      setChildName('');
      setAddingChild(false);
      onRefresh();
    } catch {
      setError('Add child failed');
    }
  }

  return (
    <div>
      <div
        className={[
          'group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg cursor-pointer text-sm transition-colors duration-150',
          isSelected ? 'bg-blue-50 text-blue-800' : 'hover:bg-gray-50 text-gray-700',
        ].join(' ')}
        onClick={() => onSelect(node)}
      >
        <button
          className="shrink-0 w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-600 rounded transition-colors duration-150"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) setOpen((v) => !v);
          }}
        >
          {hasChildren ? (
            <svg
              className={`w-3 h-3 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          ) : (
            <span className="w-3 h-3 block" />
          )}
        </button>

        {renaming ? (
          <input
            autoFocus
            className="flex-1 border border-gray-200 rounded-lg px-2 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors duration-150"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') { setRenaming(false); setRenameValue(node.name); }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 truncate text-xs leading-tight font-medium">{node.name}</span>
        )}

        {renaming ? (
          <>
            <button onClick={(e) => { e.stopPropagation(); handleRename(); }} className="text-xs text-green-600 hover:text-green-800 px-1 font-medium shrink-0">OK</button>
            <button onClick={(e) => { e.stopPropagation(); setRenaming(false); setRenameValue(node.name); }} className="text-xs text-gray-400 hover:text-gray-600 px-0.5 shrink-0">x</button>
          </>
        ) : (
          <span className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity duration-150">
            <button title="Add child" onClick={(e) => { e.stopPropagation(); setAddingChild((v) => !v); }} className="p-0.5 text-xs text-blue-600 hover:text-blue-800 rounded leading-none">+</button>
            <button title="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(true); }} className="p-0.5 text-xs text-gray-400 hover:text-gray-600 rounded leading-none">e</button>
            <button title="Delete" onClick={(e) => { e.stopPropagation(); onDeleteRequest(node.id, node.name); }} className="p-0.5 text-xs text-red-400 hover:text-red-600 rounded leading-none">x</button>
          </span>
        )}
      </div>

      {error && <p className="text-red-500 text-xs pl-6 mt-0.5">{error}</p>}

      {addingChild && (
        <div className="pl-8 flex items-center gap-1 mt-1 mb-1">
          <input
            autoFocus
            className="border border-gray-200 rounded-lg px-2 py-0.5 text-xs flex-1 focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors duration-150"
            placeholder="Child name"
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddChild();
              if (e.key === 'Escape') { setAddingChild(false); setChildName(''); }
            }}
          />
          <button onClick={handleAddChild} className="text-xs text-green-600 hover:text-green-800 font-medium">OK</button>
          <button onClick={() => { setAddingChild(false); setChildName(''); }} className="text-xs text-gray-400 hover:text-gray-600">x</button>
        </div>
      )}

      {open && hasChildren && (
        <div className="pl-3 border-l border-gray-200 ml-3">
          {node.children.map((child) => (
            <CurriculumTreeNode
              key={child.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              onRefresh={onRefresh}
              onDeleteRequest={onDeleteRequest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── CoverageNode (read-only, with card count badges) ─────────────────────────

interface CoverageNodeProps {
  node: CurriculumNode;
  depth: number;
  cardCounts: Record<string, TopicCoverageStats>;
}

function CoverageNode({ node, depth, cardCounts }: CoverageNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const stats = cardCounts[String(node.id)] ?? { total: 0, active: 0, rejected: 0, unreviewed: 0 };
  const hasCards = stats.total > 0;

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1.5 rounded-lg mx-1 transition-colors duration-150 hover:bg-gray-50"
        style={{ paddingLeft: `${10 + depth * 14}px`, paddingRight: '8px' }}
      >
        {node.children.length > 0 ? (
          <button onClick={() => setExpanded((v) => !v)} className="shrink-0 text-gray-400 hover:text-gray-600 transition-colors duration-150">
            <svg className={`h-3 w-3 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className={`flex-1 text-xs truncate font-medium ${hasCards ? 'text-gray-800' : 'text-gray-400'}`}>{node.name}</span>
        <div className="flex items-center gap-1 shrink-0">
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold tabular-nums ${hasCards ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-400'}`}>
            {stats.total}
          </span>
          {stats.unreviewed > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold tabular-nums bg-amber-50 text-amber-700">
              {stats.unreviewed}
            </span>
          )}
        </div>
      </div>
      {expanded && node.children.map((child) => (
        <CoverageNode key={child.id} node={child} depth={depth + 1} cardCounts={cardCounts} />
      ))}
    </div>
  );
}

// ─── Main Library Page ───────────────────────────────────────────────────────

export default function LibraryPage() {
  const { curriculumVersion } = useSettings();
  const [activeTab, setActiveTab] = useState<'topics' | 'documents' | 'rules'>('topics');

  // Curriculum
  const [curriculum, setCurriculum] = useState<CurriculumNode[]>([]);
  const [cardCounts, setCardCounts] = useState<Record<string, TopicCoverageStats>>({});
  const [selectedNode, setSelectedNode] = useState<CurriculumNode | null>(null);
  const [confirmDeleteNode, setConfirmDeleteNode] = useState<{ id: number; name: string } | null>(null);

  // Topic trees / documents
  const [topicTrees, setTopicTrees] = useState<TopicTree[]>([]);
  const [expandedTreeId, setExpandedTreeId] = useState<number | null>(null);
  const [expandedTree, setExpandedTree] = useState<TopicTree | null>(null);
  const [confirmDeleteTree, setConfirmDeleteTree] = useState<{ id: number; name: string } | null>(null);
  const [aiDetectingTreeId, setAiDetectingTreeId] = useState<number | null>(null);
  const [aiDetectStep, setAiDetectStep] = useState<string | null>(null);
  const [aiDetectError, setAiDetectError] = useState<string | null>(null);

  // Upload
  const [uploading, setUploading] = useState(false);
  const [processingJobId, setProcessingJobId] = useState<number | null>(null);
  const [processingStep, setProcessingStep] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Upload modal
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadCurriculumId, setUploadCurriculumId] = useState<number | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);

  // Section topic edit
  const [editingSectionId, setEditingSectionId] = useState<number | null>(null);
  const [editingTopicId, setEditingTopicId] = useState<number | null>(null);

  // Rules
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [editingRule, setEditingRule] = useState<RuleSet | null>(null);
  const [newRuleName, setNewRuleName] = useState('');
  const [newRuleContent, setNewRuleContent] = useState('');
  const [newRuleType, setNewRuleType] = useState<'generation' | 'vignette'>('generation');
  const [showNewRuleForm, setShowNewRuleForm] = useState(false);

  // Load data
  const loadCurriculum = useCallback(async () => {
    try {
      const [tree, coverage] = await Promise.all([getCurriculum(curriculumVersion), getCurriculumCoverage(curriculumVersion)]);
      setCurriculum(tree);
      setCardCounts(buildAggregatedCounts(tree, coverage));
    } catch { /* ignore */ }
  }, [curriculumVersion]);

  const loadTopicTrees = useCallback(async () => {
    try {
      const trees = await getTopicTrees();
      setTopicTrees(trees);
    } catch { /* ignore */ }
  }, []);

  const loadRuleSets = useCallback(async () => {
    try {
      const sets = await getRuleSets();
      setRuleSets(sets);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadCurriculum();
    loadTopicTrees();
    loadRuleSets();
  }, [loadCurriculum, loadTopicTrees, loadRuleSets]);

  // Expand topic tree
  const expandTree = useCallback(async (id: number) => {
    if (expandedTreeId === id) {
      setExpandedTreeId(null);
      setExpandedTree(null);
      return;
    }
    try {
      const tree = await getTopicTree(id);
      setExpandedTreeId(id);
      setExpandedTree(tree);
    } catch { /* ignore */ }
  }, [expandedTreeId]);

  // Delete curriculum node
  const handleDeleteNode = useCallback(async () => {
    if (!confirmDeleteNode) return;
    try {
      await deleteCurriculumNode(confirmDeleteNode.id);
      setConfirmDeleteNode(null);
      loadCurriculum();
    } catch { /* ignore */ }
  }, [confirmDeleteNode, loadCurriculum]);

  // Delete topic tree
  const handleDeleteTree = useCallback(async () => {
    if (!confirmDeleteTree) return;
    try {
      await deleteTopicTree(confirmDeleteTree.id);
      setConfirmDeleteTree(null);
      if (expandedTreeId === confirmDeleteTree.id) {
        setExpandedTreeId(null);
        setExpandedTree(null);
      }
      loadTopicTrees();
    } catch { /* ignore */ }
  }, [confirmDeleteTree, expandedTreeId, loadTopicTrees]);

  // AI heading detection
  const handleAiDetect = useCallback(async (treeId: number) => {
    setAiDetectingTreeId(treeId);
    setAiDetectStep('detecting…');
    setAiDetectError(null);
    try {
      const { processing_job_id } = await aiDetectHeadings(treeId, curriculumVersion);
      const interval = setInterval(async () => {
        try {
          const job = await getProcessingJob(processing_job_id);
          setAiDetectStep(job.pipeline_step ?? 'processing…');
          if (job.status === 'done' || job.status === 'failed') {
            clearInterval(interval);
            setAiDetectingTreeId(null);
            setAiDetectStep(null);
            if (job.status === 'failed') {
              setAiDetectError(job.error_message ?? 'AI heading detection failed');
            } else {
              loadTopicTrees();
              if (expandedTreeId === treeId) {
                const tree = await getTopicTree(treeId);
                setExpandedTree(tree);
              }
            }
          }
        } catch {
          clearInterval(interval);
          setAiDetectingTreeId(null);
          setAiDetectStep(null);
        }
      }, 1500);
    } catch (err: unknown) {
      setAiDetectingTreeId(null);
      setAiDetectStep(null);
      setAiDetectError(err instanceof Error ? err.message : 'AI detection failed');
    }
  }, [loadTopicTrees, expandedTreeId]);

  // Upload — open modal first
  const handleUpload = useCallback((file: File) => {
    setUploadFile(file);
    setUploadName(file.name.replace(/\.docx$/i, ''));
    setUploadCurriculumId(null);
    setShowUploadModal(true);
  }, []);

  const handleUploadConfirm = useCallback(async () => {
    if (!uploadFile) return;
    setShowUploadModal(false);
    setUploading(true);
    setUploadError(null);
    try {
      const result = await uploadDocument(uploadFile, {
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
  }, [uploadFile, uploadName, uploadCurriculumId]);

  // Save section curriculum assignment
  const handleSaveSectionTopic = useCallback(async (sectionId: number) => {
    const node = flatCurriculum.find((n) => n.id === editingTopicId) ?? null;
    try {
      await updateSection(sectionId, {
        curriculum_topic_id: editingTopicId ?? undefined,
        curriculum_topic_path: node?.path ?? undefined,
      });
      // Refresh the expanded tree so the path updates in the list
      if (expandedTreeId) {
        const tree = await getTopicTree(expandedTreeId);
        setExpandedTree(tree);
      }
    } catch { /* ignore */ }
    setEditingSectionId(null);
    setEditingTopicId(null);
  }, [editingTopicId, flatCurriculum, expandedTreeId]);

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
          }
        }
      } catch {
        clearInterval(interval);
        setProcessingJobId(null);
        setUploading(false);
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [processingJobId, loadTopicTrees]);

  // Rule CRUD
  const handleCreateRule = useCallback(async () => {
    if (!newRuleName.trim() || !newRuleContent.trim()) return;
    try {
      await createRuleSet({ name: newRuleName.trim(), content: newRuleContent.trim(), rule_type: newRuleType });
      setNewRuleName('');
      setNewRuleContent('');
      setShowNewRuleForm(false);
      loadRuleSets();
    } catch { /* ignore */ }
  }, [newRuleName, newRuleContent, newRuleType, loadRuleSets]);

  const handleUpdateRule = useCallback(async () => {
    if (!editingRule) return;
    try {
      await updateRuleSet(editingRule.id, { name: editingRule.name, content: editingRule.content });
      setEditingRule(null);
      loadRuleSets();
    } catch { /* ignore */ }
  }, [editingRule, loadRuleSets]);

  const handleDeleteRule = useCallback(async (id: number) => {
    try {
      await deleteRuleSet(id);
      loadRuleSets();
    } catch { /* ignore */ }
  }, [loadRuleSets]);

  const handleSetDefaultRule = useCallback(async (id: number) => {
    try {
      await setDefaultRuleSet(id);
      loadRuleSets();
    } catch { /* ignore */ }
  }, [loadRuleSets]);

  const flatCurriculum = useMemo(() => flattenTree(sortTree(curriculum, 'curriculum')), [curriculum]);

  const sortedCurriculum = sortTree(curriculum, 'curriculum');

  return (
    <div className="flex-1 overflow-auto bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Tab bar */}
        <div className="flex items-center gap-1 mb-6 bg-white rounded-xl p-1 shadow-sm border border-gray-200 w-fit">
          {(['topics', 'documents', 'rules'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-xs font-medium rounded-lg transition-colors duration-150 ${
                activeTab === tab
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {tab === 'topics' ? 'Topics' : tab === 'documents' ? 'Documents' : 'Rules'}
            </button>
          ))}
        </div>

        {/* Topics tab */}
        {activeTab === 'topics' && (
          <div className="grid grid-cols-2 gap-6">
            {/* Curriculum tree */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Curriculum Tree</h3>
                <button
                  onClick={() => {
                    const name = prompt('New top-level topic name:');
                    if (name?.trim()) createCurriculumNode({ name: name.trim(), version: curriculumVersion }).then(loadCurriculum);
                  }}
                  className="px-2 py-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
                >
                  + Add Root
                </button>
              </div>
              <div className="max-h-[60vh] overflow-y-auto p-2">
                {sortedCurriculum.map((node) => (
                  <CurriculumTreeNode
                    key={node.id}
                    node={node}
                    selectedId={selectedNode?.id ?? null}
                    onSelect={setSelectedNode}
                    onRefresh={loadCurriculum}
                    onDeleteRequest={(id, name) => setConfirmDeleteNode({ id, name })}
                    defaultOpen
                  />
                ))}
              </div>
            </div>

            {/* Coverage view */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Card Coverage</h3>
              </div>
              <div className="max-h-[60vh] overflow-y-auto p-2">
                {sortedCurriculum.map((node) => (
                  <CoverageNode key={node.id} node={node} depth={0} cardCounts={cardCounts} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Documents tab */}
        {activeTab === 'documents' && (
          <div>
            {/* Upload area */}
            <div className="mb-4 flex items-center gap-3">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors duration-150"
              >
                {uploading ? (processingStep ?? 'Processing...') : 'Upload .docx'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".docx"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUpload(f);
                  e.target.value = '';
                }}
              />
              {uploadError && <span className="text-xs text-red-600">{uploadError}</span>}
              {aiDetectError && (
                <span className="text-xs text-red-600">AI headings: {aiDetectError} <button onClick={() => setAiDetectError(null)} className="underline ml-1">dismiss</button></span>
              )}
            </div>

            {/* Topic tree list */}
            <div className="space-y-3">
              {topicTrees.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-12">No documents yet. Upload a .docx to get started.</p>
              ) : (
                topicTrees.map((tree) => (
                  <div key={tree.id} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div
                      className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-gray-50 transition-colors duration-150"
                      onClick={() => expandTree(tree.id)}
                    >
                      <svg
                        className={`h-3.5 w-3.5 text-gray-400 transition-transform duration-150 shrink-0 ${expandedTreeId === tree.id ? 'rotate-90' : ''}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-medium text-gray-900 truncate">{tree.name}</h4>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {tree.section_count} sections &middot; {tree.total_cards} cards &middot; {new Date(tree.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {/* AI heading detection — useful when Word heading styles weren't applied */}
                        <button
                          onClick={(e) => { e.stopPropagation(); handleAiDetect(tree.id); }}
                          disabled={aiDetectingTreeId === tree.id}
                          title="Re-process with AI-detected headings (use when document has no heading styles)"
                          className="px-2 py-1 text-xs text-indigo-600 hover:text-indigo-800 border border-indigo-200 rounded-lg hover:bg-indigo-50 disabled:opacity-50 transition-colors duration-150"
                        >
                          {aiDetectingTreeId === tree.id
                            ? (aiDetectStep ?? 'detecting…')
                            : 'AI Headings'}
                        </button>
                        {tree.total_cards > 0 && (
                          <a
                            href={exportCardsUrl({ topic_tree_id: tree.id })}
                            onClick={(e) => e.stopPropagation()}
                            className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
                          >
                            Export
                          </a>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmDeleteTree({ id: tree.id, name: tree.name }); }}
                          className="p-1.5 text-gray-300 hover:text-red-500 transition-colors duration-150"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m-7 0a1 1 0 01-1-1V5a1 1 0 011-1h6a1 1 0 011 1v1a1 1 0 01-1 1H9z" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/* Sections */}
                    {expandedTreeId === tree.id && expandedTree?.sections && (
                      <div className="border-t border-gray-100">
                        {expandedTree.sections.length === 0 ? (
                          <p className="px-4 py-3 text-xs text-gray-400">No sections</p>
                        ) : (
                          expandedTree.sections.map((section) => (
                            <div key={section.id}>
                              <div
                                className="flex items-center gap-3 px-6 py-2.5 border-b border-gray-50 last:border-b-0 hover:bg-gray-50/50 transition-colors duration-150 group/section"
                              >
                                <span
                                  className={`w-2 h-2 rounded-full shrink-0 ${
                                    section.is_verified
                                      ? 'bg-green-400'
                                      : (section.flags?.length ?? 0) > 0
                                      ? 'bg-amber-400'
                                      : 'bg-gray-300'
                                  }`}
                                />
                                <div className="flex-1 min-w-0">
                                  <span className="text-xs font-medium text-gray-700 block truncate">{section.heading}</span>
                                  <span className="text-[10px] text-gray-400 block truncate">
                                    {section.curriculum_topic_path ?? `${expandedTree.name} › ${section.heading}`}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  {(section.flags?.length ?? 0) > 0 && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 font-medium">
                                      {section.flags!.length} flag{section.flags!.length !== 1 ? 's' : ''}
                                    </span>
                                  )}
                                  <span className="text-[10px] text-gray-400 tabular-nums">{section.card_count} cards</span>
                                  <span className="text-[10px] text-gray-300">{section.image_count} img</span>
                                  <button
                                    onClick={() => {
                                      setEditingSectionId(section.id);
                                      setEditingTopicId(section.curriculum_topic_id);
                                    }}
                                    className="opacity-0 group-hover/section:opacity-100 p-1 text-gray-300 hover:text-blue-500 transition-all duration-150"
                                    title="Edit topic assignment"
                                  >
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                              {/* Inline topic editor */}
                              {editingSectionId === section.id && (
                                <div className="px-6 py-3 bg-blue-50 border-b border-blue-100 flex items-center gap-3">
                                  <div className="flex-1">
                                    <CurriculumPicker
                                      flatNodes={flatCurriculum}
                                      value={editingTopicId}
                                      onChange={setEditingTopicId}
                                      placeholder="— unassigned —"
                                    />
                                  </div>
                                  <button
                                    onClick={() => handleSaveSectionTopic(section.id)}
                                    className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 shrink-0"
                                  >
                                    Save
                                  </button>
                                  <button
                                    onClick={() => { setEditingSectionId(null); setEditingTopicId(null); }}
                                    className="px-2 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 shrink-0"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Rules tab */}
        {activeTab === 'rules' && (
          <div>
            <div className="flex items-center gap-3 mb-4">
              <h3 className="text-sm font-semibold text-gray-700">Rule Sets</h3>
              <button
                onClick={() => setShowNewRuleForm(true)}
                className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors duration-150"
              >
                + New Rule Set
              </button>
            </div>

            {/* New rule form */}
            {showNewRuleForm && (
              <div className="mb-4 bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                <div className="flex items-center gap-3 mb-3">
                  <input
                    className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors duration-150"
                    placeholder="Rule set name"
                    value={newRuleName}
                    onChange={(e) => setNewRuleName(e.target.value)}
                  />
                  <select
                    value={newRuleType}
                    onChange={(e) => setNewRuleType(e.target.value as 'generation' | 'vignette')}
                    className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    <option value="generation">Generation</option>
                    <option value="vignette">Vignette + Teaching Case</option>
                  </select>
                </div>
                <textarea
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 min-h-[120px] resize-y focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors duration-150"
                  placeholder="Rule content..."
                  value={newRuleContent}
                  onChange={(e) => setNewRuleContent(e.target.value)}
                />
                <div className="flex items-center gap-2 mt-3">
                  <button onClick={handleCreateRule} className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors duration-150">Create</button>
                  <button onClick={() => { setShowNewRuleForm(false); setNewRuleName(''); setNewRuleContent(''); }} className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-800 transition-colors duration-150">Cancel</button>
                </div>
              </div>
            )}

            {/* Rule list */}
            <div className="space-y-3">
              {ruleSets.map((rule) => (
                <div key={rule.id} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                  {editingRule?.id === rule.id ? (
                    <div className="p-4">
                      <input
                        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors duration-150"
                        value={editingRule.name}
                        onChange={(e) => setEditingRule({ ...editingRule, name: e.target.value })}
                      />
                      <textarea
                        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 min-h-[200px] resize-y focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors duration-150"
                        value={editingRule.content}
                        onChange={(e) => setEditingRule({ ...editingRule, content: e.target.value })}
                      />
                      <div className="flex items-center gap-2 mt-3">
                        <button onClick={handleUpdateRule} className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors duration-150">Save</button>
                        <button onClick={() => setEditingRule(null)} className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-800 transition-colors duration-150">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="px-4 py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-medium text-gray-900">{rule.name}</h4>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">{rule.rule_type}</span>
                          {rule.is_default && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-600 font-medium">Default</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5 truncate">{rule.content.slice(0, 100)}...</p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {!rule.is_default && (
                          <button onClick={() => handleSetDefaultRule(rule.id)} className="px-2 py-1 text-xs text-green-600 hover:bg-green-50 rounded-lg transition-colors duration-150">
                            Set Default
                          </button>
                        )}
                        <button onClick={() => setEditingRule({ ...rule })} className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 rounded-lg transition-colors duration-150">
                          Edit
                        </button>
                        <button onClick={() => handleDeleteRule(rule.id)} className="px-2 py-1 text-xs text-red-500 hover:bg-red-50 rounded-lg transition-colors duration-150">
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Confirm modals */}
      {confirmDeleteNode && (
        <ConfirmModal
          title="Delete Topic"
          message={`Delete "${confirmDeleteNode.name}" and all child topics?`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDeleteNode}
          onCancel={() => setConfirmDeleteNode(null)}
        />
      )}
      {confirmDeleteTree && (
        <ConfirmModal
          title="Delete Document"
          message={`Delete "${confirmDeleteTree.name}" and all its sections and cards?`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDeleteTree}
          onCancel={() => setConfirmDeleteTree(null)}
        />
      )}

      {/* Upload modal */}
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
    </div>
  );
}
