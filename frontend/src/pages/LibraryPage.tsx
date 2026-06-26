import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import ConfirmModal from '../components/ConfirmModal';
import CurriculumPicker from '../components/CurriculumPicker';
import ReconcileModal from '../components/ReconcileModal';
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
  scanDocument,
  updateSection,
  getProcessingJob,
  exportCardsUrl,
  aiDetectHeadings,
  getReviewMarkTypes,
  createReviewMarkType,
  updateReviewMarkType,
  deleteReviewMarkType,
  getCurriculumMappings,
  createCurriculumMapping,
  deleteCurriculumMapping,
  applyCurriculumMappings,
  getPresentations,
  deletePresentation,
} from '../api';
import type { CurriculumMapping, CurriculumNode, MergedNode, ReviewMarkType, RuleSet, ScanResult, TopicCoverageStats, TopicTree } from '../types';
import { useSettings } from '../context/SettingsContext';

// ─── Search result tree node (ancestors as context, matches bold) ─────────────

const LEVEL_BADGE = ['bg-purple-50 text-purple-700', 'bg-blue-50 text-blue-700', 'bg-green-50 text-green-700', 'bg-orange-50 text-orange-700'];

interface SearchNodeProps {
  node: CurriculumNode;
  matchIds: Set<number>;
  ancestorIds: Set<number>;
  cardCounts: Record<string, TopicCoverageStats>;
}

function SearchNode({ node, matchIds, ancestorIds, cardCounts }: SearchNodeProps) {
  const isMatch = matchIds.has(node.id);
  const isAncestor = ancestorIds.has(node.id);
  if (!isMatch && !isAncestor) return null;

  const stats = cardCounts[String(node.id)] ?? { total: 0, active: 0, unreviewed: 0, rejected: 0 };
  const reviewed = stats.active - stats.unreviewed;
  const isDimmed = isAncestor && !isMatch;
  const levelBadge = LEVEL_BADGE[Math.min(node.level, 3)];

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 py-1.5 pr-2 rounded-lg ${isDimmed ? 'hover:bg-gray-50' : 'hover:bg-gray-50'}`}
        style={{ paddingLeft: `${8 + node.level * 14}px` }}
      >
        <span className={`text-[9px] font-bold w-4 text-center rounded shrink-0 py-px ${levelBadge}`}>{node.level}</span>
        <span className={`flex-1 text-xs truncate ${isDimmed ? 'text-gray-400' : 'font-semibold text-gray-800'}`}>{node.name}</span>
        {!isDimmed && stats.active > 0 && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold tabular-nums shrink-0 ${stats.unreviewed === 0 ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-700'}`}>
            {reviewed}/{stats.active}
          </span>
        )}
        {!isDimmed && stats.unreviewed > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold tabular-nums bg-amber-50 text-amber-700 shrink-0">{stats.unreviewed}</span>
        )}
      </div>
      {node.children.map((child) => (
        <SearchNode key={child.id} node={child} matchIds={matchIds} ancestorIds={ancestorIds} cardCounts={cardCounts} />
      ))}
    </div>
  );
}

// ─── Unified TopicNode (coverage + optional edit controls) ───────────────────

interface TopicNodeProps {
  node: CurriculumNode;
  depth: number;
  cardCounts: Record<string, TopicCoverageStats>;
  editMode: boolean;
  onRefresh: () => void;
  onDeleteRequest: (id: number, name: string) => void;
}

function topicStyle(active: number, unreviewed: number) {
  if (active === 0) return 'text-gray-400';
  if (unreviewed === 0) return 'text-green-700';
  return 'text-gray-800';
}

function TopicNode({ node, depth, cardCounts, editMode, onRefresh, onDeleteRequest }: TopicNodeProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [addingChild, setAddingChild] = useState(false);
  const [childName, setChildName] = useState('');

  const hasChildren = node.children.length > 0;
  const stats = cardCounts[String(node.id)] ?? { total: 0, active: 0, rejected: 0, unreviewed: 0 };
  const active = stats.active;
  const unreviewed = stats.unreviewed;
  const reviewed = active - unreviewed;

  async function handleRename() {
    if (!renameValue.trim() || renameValue === node.name) { setRenaming(false); setRenameValue(node.name); return; }
    try { await updateCurriculumNode(node.id, { name: renameValue.trim() }); onRefresh(); } catch { /* ignore */ }
    setRenaming(false);
  }

  async function handleAddChild() {
    if (!childName.trim()) return;
    try { await createCurriculumNode({ name: childName.trim(), parent_id: node.id }); onRefresh(); } catch { /* ignore */ }
    setAddingChild(false); setChildName('');
  }

  return (
    <div>
      <div
        className="group/node flex items-center gap-1.5 py-1.5 pr-2 rounded-lg hover:bg-gray-50 transition-colors duration-150 cursor-default"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {/* Expand arrow */}
        {hasChildren ? (
          <button onClick={() => setOpen((v) => !v)} className="shrink-0 text-gray-400 hover:text-gray-600 transition-colors duration-150">
            <svg className={`h-3 w-3 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {/* Name / rename input */}
        {renaming ? (
          <input
            autoFocus
            className="flex-1 border border-blue-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') { setRenaming(false); setRenameValue(node.name); } }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className={`flex-1 text-xs font-medium truncate ${topicStyle(active, unreviewed)}`}>{node.name}</span>
        )}

        {/* Coverage badges (always visible, hidden while renaming) */}
        {!renaming && (
          <div className="flex items-center gap-1 shrink-0">
            {active > 0 && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold tabular-nums ${unreviewed === 0 ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-700'}`}>
                {reviewed}/{active}
              </span>
            )}
            {unreviewed > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold tabular-nums bg-amber-50 text-amber-700">
                {unreviewed}
              </span>
            )}
          </div>
        )}

        {/* Edit-mode CRUD buttons (hover-revealed) */}
        {editMode && !renaming && (
          <div className="opacity-0 group-hover/node:opacity-100 flex items-center gap-0.5 shrink-0 ml-0.5 transition-opacity duration-150" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { setAddingChild((v) => !v); setChildName(''); }} title="Add child" className="p-0.5 text-gray-300 hover:text-blue-500 rounded transition-colors duration-150">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
            </button>
            <button onClick={() => { setRenaming(true); setRenameValue(node.name); }} title="Rename" className="p-0.5 text-gray-300 hover:text-amber-500 rounded transition-colors duration-150">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
            </button>
            <button onClick={() => onDeleteRequest(node.id, node.name)} disabled={hasChildren} title={hasChildren ? 'Remove children first' : 'Delete'} className={`p-0.5 rounded transition-colors duration-150 ${hasChildren ? 'text-gray-200 cursor-not-allowed' : 'text-gray-300 hover:text-red-500'}`}>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6" /></svg>
            </button>
          </div>
        )}
      </div>

      {/* Add child inline input */}
      {editMode && addingChild && (
        <div className="flex items-center gap-1 pr-2 mb-1" style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }} onClick={(e) => e.stopPropagation()}>
          <input
            autoFocus
            className="flex-1 border border-blue-300 rounded px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 bg-blue-50/50"
            placeholder="New topic name…"
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
            onBlur={() => { setAddingChild(false); setChildName(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddChild(); } if (e.key === 'Escape') { setAddingChild(false); setChildName(''); } }}
          />
        </div>
      )}

      {/* Children */}
      {open && hasChildren && node.children.map((child) => (
        <TopicNode key={child.id} node={child} depth={depth + 1} cardCounts={cardCounts} editMode={editMode} onRefresh={onRefresh} onDeleteRequest={onDeleteRequest} />
      ))}
    </div>
  );
}

// ─── Main Library Page ───────────────────────────────────────────────────────

export default function LibraryPage() {
  const { curriculumVersion } = useSettings();
  const [activeTab, setActiveTab] = useState<'topics' | 'documents' | 'rules' | 'marks' | 'mapping' | 'presentations'>('topics');

  // Curriculum
  const [curriculum, setCurriculum] = useState<CurriculumNode[]>([]);
  const [cardCounts, setCardCounts] = useState<Record<string, TopicCoverageStats>>({});
  const [confirmDeleteNode, setConfirmDeleteNode] = useState<{ id: number; name: string } | null>(null);
  // Topics tab controls
  const [topicSearch, setTopicSearch] = useState('');
  const [topicEditMode, setTopicEditMode] = useState(false);
  const [topicSort, setTopicSort] = useState<'curriculum' | 'alpha'>('curriculum');
  const [addingRootTopic, setAddingRootTopic] = useState(false);
  const [rootTopicName, setRootTopicName] = useState('');

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
  const [reconcile, setReconcile] = useState<{ scanToken: string; tree: MergedNode; summary: ScanResult['summary'] } | null>(null);

  // Section topic edit
  const [editingSectionId, setEditingSectionId] = useState<number | null>(null);
  const [editingTopicId, setEditingTopicId] = useState<number | null>(null);

  // Review marks
  const [markTypes, setMarkTypes] = useState<ReviewMarkType[]>([]);
  const [addingMark, setAddingMark] = useState(false);
  const [newMarkName, setNewMarkName] = useState('');
  const [newMarkColor, setNewMarkColor] = useState('#6b7280');
  const [editingMark, setEditingMark] = useState<ReviewMarkType | null>(null);

  // Mapping tab
  const [fromTree, setFromTree] = useState<CurriculumNode[]>([]); // v2 / Current
  const [toTree, setToTree] = useState<CurriculumNode[]>([]);     // v1 / New
  const [mappings, setMappings] = useState<CurriculumMapping[]>([]);
  const [selectedFromId, setSelectedFromId] = useState<number | null>(null);
  const [fromExpanded, setFromExpanded] = useState<Set<number>>(new Set());
  const [toExpanded, setToExpanded] = useState<Set<number>>(new Set());
  const [applyingMappings, setApplyingMappings] = useState(false);
  const [applyResult, setApplyResult] = useState<{ updated: number; total_cards: number } | null>(null);

  // Rules
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [editingRule, setEditingRule] = useState<RuleSet | null>(null);
  const [newRuleName, setNewRuleName] = useState('');
  const [newRuleContent, setNewRuleContent] = useState('');
  const [newRuleType, setNewRuleType] = useState<'generation' | 'vignette'>('generation');
  const [newRuleCardVersion, setNewRuleCardVersion] = useState<'base' | 'v1' | 'v2' | 'v3'>('base');
  const [showNewRuleForm, setShowNewRuleForm] = useState(false);

  // Presentations
  const [presentations, setPresentations] = useState<import('../types').Presentation[]>([]);
  const [presentationsLoading, setPresentationsLoading] = useState(false);
  const [confirmDeletePresentation, setConfirmDeletePresentation] = useState<{ id: number; name: string } | null>(null);

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

  const loadMarkTypes = useCallback(async () => {
    try {
      const marks = await getReviewMarkTypes();
      setMarkTypes(marks);
    } catch { /* ignore */ }
  }, []);

  const loadPresentations = useCallback(async () => {
    setPresentationsLoading(true);
    try {
      const list = await getPresentations();
      setPresentations(list);
    } catch { /* ignore */ }
    finally { setPresentationsLoading(false); }
  }, []);

  useEffect(() => {
    loadCurriculum();
    loadTopicTrees();
    loadRuleSets();
  }, [loadCurriculum, loadTopicTrees, loadRuleSets]);

  useEffect(() => {
    if (activeTab === 'presentations') loadPresentations();
  }, [activeTab, loadPresentations]);

  useEffect(() => { loadMarkTypes(); }, [loadMarkTypes]);

  const loadMappingData = useCallback(async () => {
    try {
      const [ft, tt, ms] = await Promise.all([getCurriculum('v2'), getCurriculum('v1'), getCurriculumMappings()]);
      setFromTree(ft);
      setToTree(tt);
      setMappings(ms);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (activeTab === 'mapping') loadMappingData();
  }, [activeTab, loadMappingData]);

  const flatCurriculum = useMemo(() => flattenTree(sortTree(curriculum, 'curriculum')), [curriculum]);
  const flatCurriculumForSearch = useMemo(() => flattenTree(curriculum), [curriculum]);

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
      const scan = await scanDocument(uploadFile, {
        topicTreeName: uploadName || undefined,
        curriculumId: uploadCurriculumId ?? undefined,
      });
      // Park at the reconcile gate — nothing is processing yet (no DB rows).
      setReconcile({ scanToken: scan.scan_token, tree: scan.tree, summary: scan.summary });
      setUploadFile(null);
      setUploading(false);
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
      await createRuleSet({ name: newRuleName.trim(), content: newRuleContent.trim(), rule_type: newRuleType, card_version: newRuleCardVersion });
      setNewRuleName('');
      setNewRuleContent('');
      setShowNewRuleForm(false);
      loadRuleSets();
    } catch { /* ignore */ }
  }, [newRuleName, newRuleContent, newRuleType, newRuleCardVersion, loadRuleSets]);

  const handleUpdateRule = useCallback(async () => {
    if (!editingRule) return;
    try {
      await updateRuleSet(editingRule.id, { name: editingRule.name, content: editingRule.content, card_version: editingRule.card_version });
      setEditingRule(null);
      loadRuleSets();
    } catch { /* ignore */ }
  }, [editingRule, loadRuleSets]);

  const handleDeletePresentation = useCallback(async (id: number) => {
    try {
      await deletePresentation(id);
      loadPresentations();
    } catch { /* ignore */ }
    setConfirmDeletePresentation(null);
  }, [loadPresentations]);

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

  const handleCreateMark = async () => {
    if (!newMarkName.trim()) return;
    try {
      await createReviewMarkType({ name: newMarkName.trim(), color: newMarkColor });
      setNewMarkName('');
      setNewMarkColor('#6b7280');
      setAddingMark(false);
      loadMarkTypes();
    } catch { /* ignore */ }
  };

  const handleUpdateMark = async () => {
    if (!editingMark) return;
    try {
      await updateReviewMarkType(editingMark.id, { name: editingMark.name, color: editingMark.color });
      setEditingMark(null);
      loadMarkTypes();
    } catch { /* ignore */ }
  };

  const handleDeleteMark = async (id: number) => {
    try {
      await deleteReviewMarkType(id);
      loadMarkTypes();
    } catch { /* ignore */ }
  };

  const sortedCurriculum = useMemo(() => sortTree(curriculum, topicSort), [curriculum, topicSort]);

  return (
    <div className="flex-1 overflow-auto bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Tab bar */}
        <div className="flex items-center gap-1 mb-6 bg-white rounded-xl p-1 shadow-sm border border-gray-200 w-fit">
          {(['topics', 'documents', 'rules', 'marks', 'mapping', 'presentations'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-xs font-medium rounded-lg transition-colors duration-150 ${
                activeTab === tab
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {tab === 'topics' ? 'Topics' : tab === 'documents' ? 'Documents' : tab === 'rules' ? 'Rules' : tab === 'marks' ? 'Marks' : tab === 'mapping' ? 'Mapping' : 'Presentations'}
            </button>
          ))}
        </div>

        {/* Topics tab */}
        {activeTab === 'topics' && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            {/* Toolbar */}
            <div className="px-4 py-3 border-b border-gray-100 flex flex-col gap-2">
              {/* Search */}
              <div className="relative">
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  className="w-full pl-8 pr-7 py-1.5 text-xs border border-gray-200 rounded-lg bg-gray-50 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors duration-150"
                  placeholder="Search topics…"
                  value={topicSearch}
                  onChange={(e) => setTopicSearch(e.target.value)}
                />
                {topicSearch && (
                  <button onClick={() => setTopicSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                )}
              </div>
              {/* Controls row */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setTopicEditMode((v) => !v)}
                  className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-lg border transition-colors duration-150 ${topicEditMode ? 'bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                  {topicEditMode ? 'Done' : 'Edit'}
                </button>
                <button
                  onClick={() => setTopicSort((v) => v === 'curriculum' ? 'alpha' : 'curriculum')}
                  title={topicSort === 'curriculum' ? 'Curriculum order — click for A–Z' : 'Alphabetical — click for curriculum order'}
                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-lg border bg-white text-gray-600 border-gray-200 hover:bg-gray-50 transition-colors duration-150 ml-auto"
                >
                  {topicSort === 'alpha' ? 'A–Z' : '# Order'}
                </button>
              </div>
            </div>

            {/* Tree / search results */}
            <div className="overflow-y-auto p-2" style={{ maxHeight: 'calc(100vh - 260px)' }}>
              {curriculum.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-8">No curriculum topics loaded.</p>
              ) : topicSearch.trim() ? (
                // Tree-aware search results with ancestors as context
                (() => {
                  const q = topicSearch.toLowerCase();
                  const matchIds = new Set<number>();
                  for (const n of flatCurriculumForSearch) {
                    if (n.name.toLowerCase().includes(q)) matchIds.add(n.id);
                  }
                  if (matchIds.size === 0) return (
                    <p className="text-xs text-gray-400 italic px-2 py-2">No matches for "{topicSearch}"</p>
                  );
                  // Collect ancestors
                  const ancestorIds = new Set<number>();
                  const parentMap = new Map(flatCurriculumForSearch.map((n) => [n.id, n.parent_id]));
                  for (const id of matchIds) {
                    let cur = parentMap.get(id) ?? null;
                    while (cur != null) { ancestorIds.add(cur); cur = parentMap.get(cur) ?? null; }
                  }
                  return sortedCurriculum.map((root) => (
                    <SearchNode key={root.id} node={root} matchIds={matchIds} ancestorIds={ancestorIds} cardCounts={cardCounts} />
                  ));
                })()
              ) : (
                // Collapsible tree
                sortedCurriculum.map((node) => (
                  <TopicNode
                    key={node.id}
                    node={node}
                    depth={0}
                    cardCounts={cardCounts}
                    editMode={topicEditMode}
                    onRefresh={loadCurriculum}
                    onDeleteRequest={(id, name) => setConfirmDeleteNode({ id, name })}
                  />
                ))
              )}

              {/* Add root topic (edit mode only) */}
              {topicEditMode && !topicSearch && (
                <div className="px-2 pt-1 pb-2">
                  {addingRootTopic ? (
                    <input
                      autoFocus
                      className="w-full border border-blue-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 bg-blue-50/50"
                      placeholder="New root topic name…"
                      value={rootTopicName}
                      onChange={(e) => setRootTopicName(e.target.value)}
                      onBlur={() => { setAddingRootTopic(false); setRootTopicName(''); }}
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter' && rootTopicName.trim()) {
                          await createCurriculumNode({ name: rootTopicName.trim(), version: curriculumVersion });
                          setAddingRootTopic(false); setRootTopicName('');
                          loadCurriculum();
                        }
                        if (e.key === 'Escape') { setAddingRootTopic(false); setRootTopicName(''); }
                      }}
                    />
                  ) : (
                    <button
                      onClick={() => { setAddingRootTopic(true); setRootTopicName(''); }}
                      className="flex items-center gap-1 w-full px-2 py-1 text-xs text-gray-400 hover:text-blue-600 rounded-lg hover:bg-blue-50 transition-colors duration-150"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                      Add root topic
                    </button>
                  )}
                </div>
              )}
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
                  {newRuleType === 'generation' && (
                    <select
                      value={newRuleCardVersion}
                      onChange={(e) => setNewRuleCardVersion(e.target.value as 'base' | 'v1' | 'v2' | 'v3')}
                      className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-600"
                      title="Which card version slot this rule set generates into"
                    >
                      <option value="base">Base</option>
                      <option value="v1">V1</option>
                      <option value="v2">V2</option>
                      <option value="v3">V3</option>
                    </select>
                  )}
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
                      <div className="flex items-center gap-3 mb-3">
                        <input
                          className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors duration-150"
                          value={editingRule.name}
                          onChange={(e) => setEditingRule({ ...editingRule, name: e.target.value })}
                        />
                        {editingRule.rule_type === 'generation' && (
                          <select
                            value={editingRule.card_version}
                            onChange={(e) => setEditingRule({ ...editingRule, card_version: e.target.value as 'base' | 'v1' | 'v2' | 'v3' })}
                            className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-600"
                            title="Which card version slot this rule set generates into"
                          >
                            <option value="base">Base</option>
                            <option value="v1">V1</option>
                            <option value="v2">V2</option>
                            <option value="v3">V3</option>
                          </select>
                        )}
                      </div>
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
                          {rule.rule_type === 'generation' && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${rule.card_version === 'base' ? 'bg-gray-50 text-gray-400' : 'bg-violet-50 text-violet-600'}`}>
                              {rule.card_version === 'base' ? 'base' : rule.card_version.toUpperCase()}
                            </span>
                          )}
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

        {/* Marks tab */}
        {activeTab === 'marks' && (
          <div className="max-w-md">
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Review Mark Types</h3>
              <button
                onClick={() => setAddingMark(true)}
                className="ml-auto px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors duration-150"
              >
                + New
              </button>
            </div>

            {/* New mark form */}
            {addingMark && (
              <div className="mb-3 bg-white rounded-lg border border-gray-200 p-3">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={newMarkColor}
                    onChange={(e) => setNewMarkColor(e.target.value)}
                    className="h-7 w-7 rounded cursor-pointer border border-gray-200 shrink-0"
                  />
                  <input
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    placeholder="e.g. Too many clozes"
                    value={newMarkName}
                    onChange={(e) => setNewMarkName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCreateMark(); if (e.key === 'Escape') { setAddingMark(false); setNewMarkName(''); } }}
                    autoFocus
                  />
                  <button onClick={handleCreateMark} disabled={!newMarkName.trim()} className="px-2.5 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors duration-150">Create</button>
                  <button onClick={() => { setAddingMark(false); setNewMarkName(''); }} className="text-xs text-gray-400 hover:text-gray-600 px-1">✕</button>
                </div>
              </div>
            )}

            {/* Mark list */}
            <div className="space-y-1.5">
              {markTypes.length === 0 && !addingMark && (
                <div className="bg-white rounded-lg border border-gray-200 px-4 py-5 text-center text-xs text-gray-400">
                  No mark types yet. Create one to start flagging cards.
                </div>
              )}
              {markTypes.map((mark) => (
                <div key={mark.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  {editingMark?.id === mark.id ? (
                    <div className="px-3 py-2 flex items-center gap-2">
                      <input
                        type="color"
                        value={editingMark.color}
                        onChange={(e) => setEditingMark({ ...editingMark, color: e.target.value })}
                        className="h-7 w-7 rounded cursor-pointer border border-gray-200 shrink-0"
                      />
                      <input
                        className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-600"
                        value={editingMark.name}
                        onChange={(e) => setEditingMark({ ...editingMark, name: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleUpdateMark(); if (e.key === 'Escape') setEditingMark(null); }}
                        autoFocus
                      />
                      <button onClick={handleUpdateMark} className="px-2.5 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors duration-150">Save</button>
                      <button onClick={() => setEditingMark(null)} className="text-xs text-gray-400 hover:text-gray-600 px-1">✕</button>
                    </div>
                  ) : (
                    <div className="px-3 py-2 flex items-center gap-2.5">
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: mark.color }} />
                      <span className="flex-1 text-xs font-medium text-gray-800">{mark.name}</span>
                      <button onClick={() => setEditingMark(mark)} className="text-[10px] text-gray-400 hover:text-blue-600 transition-colors px-1.5 py-0.5">Edit</button>
                      <button onClick={() => handleDeleteMark(mark.id)} className="text-[10px] text-gray-400 hover:text-red-600 transition-colors px-1.5 py-0.5">Delete</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Mapping tab */}
        {activeTab === 'mapping' && (() => {
          const mappedFromIds = new Set(mappings.map(m => m.from_node_id));
          const selectedMappings = mappings.filter(m => m.from_node_id === selectedFromId);
          const mappedToIds = new Set(selectedMappings.map(m => m.to_node_id));

          const handleToggleMapping = async (toNodeId: number) => {
            if (!selectedFromId) return;
            const existing = selectedMappings.find(m => m.to_node_id === toNodeId);
            if (existing) {
              await deleteCurriculumMapping(existing.id);
            } else {
              await createCurriculumMapping(selectedFromId, toNodeId);
            }
            const updated = await getCurriculumMappings();
            setMappings(updated);
          };

          const handleApply = async () => {
            setApplyingMappings(true);
            setApplyResult(null);
            try {
              const result = await applyCurriculumMappings();
              setApplyResult(result);
            } catch { /* ignore */ }
            setApplyingMappings(false);
          };

          function MappingTreeNode({ node, side }: { node: CurriculumNode; side: 'from' | 'to' }) {
            const expanded = side === 'from' ? fromExpanded.has(node.id) : toExpanded.has(node.id);
            const setExpanded = side === 'from' ? setFromExpanded : setToExpanded;
            const hasChildren = node.children.length > 0;
            const isSelected = side === 'from' && selectedFromId === node.id;
            const isMapped = side === 'from' && mappedFromIds.has(node.id);
            const isChecked = side === 'to' && mappedToIds.has(node.id);

            return (
              <div>
                <div
                  className={`flex items-center gap-1 py-1 pr-2 rounded-lg cursor-pointer ${
                    isSelected ? 'bg-indigo-50' : 'hover:bg-gray-50'
                  }`}
                  style={{ paddingLeft: `${6 + node.level * 14}px` }}
                  onClick={() => {
                    if (hasChildren) setExpanded(prev => { const s = new Set(prev); s.has(node.id) ? s.delete(node.id) : s.add(node.id); return s; });
                    if (side === 'from') { setSelectedFromId(node.id); setApplyResult(null); }
                    if (side === 'to') handleToggleMapping(node.id);
                  }}
                >
                  {side === 'to' && (
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => handleToggleMapping(node.id)}
                      onClick={e => e.stopPropagation()}
                      className="rounded border-gray-300 text-blue-600 shrink-0"
                    />
                  )}
                  {hasChildren ? (
                    <span className="text-gray-400 text-[10px] w-3 shrink-0">{expanded ? '▾' : '▸'}</span>
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                  <span className={`flex-1 text-xs truncate ${isSelected ? 'font-semibold text-indigo-700' : 'text-gray-700'}`}>{node.name}</span>
                  {isMapped && <span className="text-[9px] font-bold text-indigo-500 shrink-0 ml-1">→</span>}
                </div>
                {expanded && hasChildren && node.children.map(child => (
                  <MappingTreeNode key={child.id} node={child} side={side} />
                ))}
              </div>
            );
          }

          return (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3 bg-white rounded-xl border border-gray-200 px-4 py-3 shadow-sm">
                <div className="flex-1">
                  <p className="text-xs font-semibold text-gray-700">Apply Mappings to Cards</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">Populates the "New" tags on all cards based on defined mappings.</p>
                </div>
                {applyResult && (
                  <span className="text-xs text-green-700 bg-green-50 border border-green-200 px-2.5 py-1 rounded-lg font-medium">
                    Updated {applyResult.updated} / {applyResult.total_cards} cards
                  </span>
                )}
                <button
                  onClick={handleApply}
                  disabled={applyingMappings || mappings.length === 0}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors duration-150 shrink-0"
                >
                  {applyingMappings ? 'Applying…' : `Apply (${mappings.length} mappings)`}
                </button>
              </div>

              <div className="flex gap-3" style={{ height: '62vh' }}>
                <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-gray-100 shrink-0">
                    <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Current — select a topic</p>
                  </div>
                  <div className="overflow-y-auto flex-1 p-2">
                    {fromTree.map(node => <MappingTreeNode key={node.id} node={node} side="from" />)}
                  </div>
                </div>

                <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-gray-100 shrink-0 flex items-center gap-2">
                    <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide flex-1">New — check to map</p>
                    {selectedFromId == null && <span className="text-[11px] text-gray-300">← select a topic first</span>}
                  </div>
                  <div className={`overflow-y-auto flex-1 p-2 transition-opacity ${selectedFromId == null ? 'opacity-30 pointer-events-none' : ''}`}>
                    {toTree.map(node => <MappingTreeNode key={node.id} node={node} side="to" />)}
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Presentations tab */}
        {activeTab === 'presentations' && (
          <div>
            <div className="flex items-center gap-3 mb-4">
              <h3 className="text-sm font-semibold text-gray-700">Ankify Presentations</h3>
              <button
                onClick={loadPresentations}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
              >
                Refresh
              </button>
            </div>
            {presentationsLoading ? (
              <p className="text-xs text-gray-400">Loading...</p>
            ) : presentations.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                <p className="text-sm">No presentations yet.</p>
                <p className="text-xs mt-1">Create one from the Workspace by selecting cards and clicking "Save Presentation".</p>
              </div>
            ) : (
              <div className="space-y-2">
                {presentations.map((p) => (
                  <div key={p.id} className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 truncate">{p.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${p.card_version === 'base' ? 'bg-gray-50 text-gray-400' : 'bg-violet-50 text-violet-600'}`}>
                          {p.card_version === 'base' ? 'base' : p.card_version.toUpperCase()}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">
                          {p.source_type === 'topic' ? 'full topic' : `${(p.card_ids ?? []).length} cards`}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5 font-mono">/anki/{p.slug}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => window.open(`/anki/${p.slug}`, '_blank')}
                        className="px-2.5 py-1 text-xs font-medium text-violet-700 bg-violet-50 border border-violet-200 rounded-lg hover:bg-violet-100 transition-colors duration-150"
                      >
                        Open
                      </button>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}/anki/${p.slug}`);
                        }}
                        className="px-2.5 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
                        title="Copy link"
                      >
                        Copy Link
                      </button>
                      <button
                        onClick={() => setConfirmDeletePresentation({ id: p.id, name: p.name })}
                        className="px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 rounded-lg transition-colors duration-150"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Confirm modals */}
      {confirmDeletePresentation && (
        <ConfirmModal
          title="Delete Presentation"
          message={`Delete "${confirmDeletePresentation.name}"? The link will stop working.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => handleDeletePresentation(confirmDeletePresentation.id)}
          onCancel={() => setConfirmDeletePresentation(null)}
        />
      )}
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

      {/* Curriculum reconcile gate — appears after a scan */}
      {reconcile && (
        <ReconcileModal
          scanToken={reconcile.scanToken}
          tree={reconcile.tree}
          summary={reconcile.summary}
          onClose={() => setReconcile(null)}
          onContinue={(jobId) => {
            setReconcile(null);
            setUploading(true);
            setProcessingJobId(jobId);
          }}
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
