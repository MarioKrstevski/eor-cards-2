import axios from 'axios';
import type {
  CurriculumNode,
  MergedNode,
  CurriculumMapping,
  CurriculumSection,
  TopicCoverageStats,
  RuleSet,
  TopicTree,
  Section,
  SectionDetail,
  Card,
  CardStatus,
  Model,
  CostEstimate,
  GenerationJob,
  ProcessingJob,
  PaginatedCards,
  AIUsageSummary,
  ReviewMarkType,
  FixBatch,
  FixProposal,
  Presentation,
  SectionImage,
  ScanResult,
} from './types';

const http = axios.create({ baseURL: '/api' });

/** Human-useful message from an API error: prefers the backend's `detail`
 * (which now carries the precise failure reason, e.g. "ValueError: …") over
 * axios's generic "Request failed with status code 500". */
export function apiErrorMessage(err: unknown, fallback = 'Request failed'): string {
  if (axios.isAxiosError(err)) {
    const detail = (err.response?.data as { detail?: unknown } | undefined)?.detail;
    if (typeof detail === 'string' && detail) return detail;
    return err.message || fallback;
  }
  return err instanceof Error ? err.message : fallback;
}

// ─── Curriculum ───────────────────────────────────────────────────────────────

export async function getCurriculum(version = 'v1'): Promise<CurriculumNode[]> {
  const res = await http.get<CurriculumNode[]>('/curriculum', { params: { version } });
  return res.data;
}

export async function getCurriculumCoverage(version = 'v1'): Promise<Record<string, TopicCoverageStats>> {
  const res = await http.get<Record<string, TopicCoverageStats>>('/curriculum/coverage', { params: { version } });
  return res.data;
}

export async function importCurriculum(version: string, nodes: unknown[]): Promise<{ imported: number }> {
  const res = await http.post<{ imported: number }>('/curriculum/import', { version, nodes });
  return res.data;
}

export async function createCurriculumNode(params: {
  name: string;
  parent_id?: number | null;
  version?: string;
}): Promise<CurriculumNode> {
  const res = await http.post<CurriculumNode>('/curriculum', params);
  return res.data;
}

export async function updateCurriculumNode(
  id: number,
  params: { name?: string; color?: string | null; cascade_green?: boolean }
): Promise<CurriculumNode> {
  const res = await http.patch<CurriculumNode>(`/curriculum/${id}`, params);
  return res.data;
}

export async function deleteCurriculumNode(id: number, subtree = false): Promise<void> {
  await http.delete(`/curriculum/${id}`, { params: subtree ? { subtree: true } : undefined });
}

// Compare a pasted nested-topic JSON (expected blueprint) against the system's
// subtree under a main topic. 'missing' in the result = extra in system (intruder).
export async function compareCurriculum(
  mainTopicId: number,
  nodes: unknown
): Promise<{ tree: MergedNode; summary: { depth: number; expected: number; present: number }[] }> {
  const res = await http.post<{ tree: MergedNode; summary: { depth: number; expected: number; present: number }[] }>(
    '/curriculum/compare',
    { main_topic_id: mainTopicId, nodes }
  );
  return res.data;
}

// TEMPORARY: replace a main topic's whole subtree with pasted blueprint JSON.
export async function resetCurriculumTopic(
  nodeId: number,
  nodes: unknown
): Promise<{ imported: number; removed_topics: number; removed_sections: number }> {
  const res = await http.post<{ imported: number; removed_topics: number; removed_sections: number }>(
    `/curriculum/${nodeId}/reset`,
    { nodes }
  );
  return res.data;
}

// TEMPORARY: bulk-delete all green-marked topic subtrees (+ their sections).
export async function deleteGreenTopics(version: string): Promise<{ removed_topics: number; removed_sections: number }> {
  const res = await http.delete<{ removed_topics: number; removed_sections: number }>('/curriculum/green', {
    params: { version },
  });
  return res.data;
}

// ─── Curriculum Mappings ──────────────────────────────────────────────────────

export async function getCurriculumMappings(fromNodeId?: number): Promise<CurriculumMapping[]> {
  const res = await http.get<CurriculumMapping[]>('/curriculum/mappings', {
    params: fromNodeId != null ? { from_node_id: fromNodeId } : undefined,
  });
  return res.data;
}

export async function createCurriculumMapping(fromNodeId: number, toNodeId: number): Promise<CurriculumMapping> {
  const res = await http.post<CurriculumMapping>('/curriculum/mappings', {
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
  });
  return res.data;
}

export async function deleteCurriculumMapping(id: number): Promise<void> {
  await http.delete(`/curriculum/mappings/${id}`);
}

export async function applyCurriculumMappings(): Promise<{ updated: number; total_cards: number; mappings_defined: number }> {
  const res = await http.post<{ updated: number; total_cards: number; mappings_defined: number }>('/curriculum/mappings/apply');
  return res.data;
}

// ─── Topic Trees (Documents) ─────────────────────────────────────────────────

export async function getTopicTrees(): Promise<TopicTree[]> {
  const res = await http.get<TopicTree[]>('/topic-trees');
  return res.data;
}

export async function getTopicTree(id: number): Promise<TopicTree> {
  const res = await http.get<TopicTree>(`/topic-trees/${id}`);
  return res.data;
}

// Scan a document against the curriculum WITHOUT creating any DB rows. Returns a
// merged diff-tree + a scan_token used to continue processing later.
export async function scanDocument(
  file: File,
  opts: { topicTreeId?: number; topicTreeName?: string; curriculumId?: number }
): Promise<ScanResult> {
  const form = new FormData();
  form.append('file', file);
  if (opts.topicTreeId != null) form.append('topic_tree_id', String(opts.topicTreeId));
  if (opts.topicTreeName) form.append('topic_tree_name', opts.topicTreeName);
  if (opts.curriculumId != null) form.append('curriculum_id', String(opts.curriculumId));
  const res = await http.post<ScanResult>('/topic-trees/scan', form);
  return res.data;
}

export async function deleteScan(scanToken: string): Promise<void> {
  await http.delete(`/topic-trees/scan/${scanToken}`);
}

export async function continueProcessing(
  scanToken: string,
  includedHids: number[]
): Promise<{ processing_job_id: number; topic_tree_id: number }> {
  const res = await http.post<{ processing_job_id: number; topic_tree_id: number }>(
    '/topic-trees/continue',
    { scan_token: scanToken, included_hids: includedHids }
  );
  return res.data;
}

export async function pasteDocument(
  html: string,
  name: string,
  opts?: { topicTreeId?: number; curriculumId?: number }
): Promise<{ upload_id: number; processing_job_id: number; topic_tree_id: number }> {
  const res = await http.post<{ upload_id: number; processing_job_id: number; topic_tree_id: number }>(
    '/topic-trees/paste',
    {
      html,
      name,
      topic_tree_id: opts?.topicTreeId ?? null,
      curriculum_id: opts?.curriculumId ?? null,
    }
  );
  return res.data;
}

export async function deleteTopicTree(id: number): Promise<void> {
  await http.delete(`/topic-trees/${id}`);
}

export async function aiDetectHeadings(id: number, curriculumVersion = 'v1'): Promise<{ processing_job_id: number }> {
  const res = await http.post<{ processing_job_id: number }>(`/topic-trees/${id}/ai-headings`, null, {
    params: { curriculum_version: curriculumVersion },
  });
  return res.data;
}

export async function getProcessingJob(jobId: number): Promise<ProcessingJob> {
  const res = await http.get<ProcessingJob>(`/topic-trees/processing-jobs/${jobId}`);
  return res.data;
}

// ─── Sections ────────────────────────────────────────────────────────────────

export async function getSection(id: number): Promise<SectionDetail> {
  const res = await http.get<SectionDetail>(`/sections/${id}`);
  return res.data;
}

export async function updateSection(
  id: number,
  params: { heading?: string; curriculum_topic_id?: number | null; curriculum_topic_path?: string | null; is_verified?: boolean; is_done?: boolean; section_status?: string }
): Promise<Section> {
  const res = await http.patch<Section>(`/sections/${id}`, params);
  return res.data;
}

export async function getSectionsByCurriculum(path: string): Promise<CurriculumSection[]> {
  const res = await http.get<CurriculumSection[]>('/sections/by-curriculum', { params: { path } });
  return res.data;
}

export async function pasteSectionContent(
  sectionId: number,
  html: string
): Promise<SectionDetail> {
  const res = await http.post<SectionDetail>(`/sections/${sectionId}/paste`, { html });
  return res.data;
}

export async function updateSectionImage(
  sectionId: number,
  imageId: number,
  params: { category?: string; alt_text_hint?: string; intended_position?: string | null }
): Promise<SectionImage> {
  const res = await http.patch<SectionImage>(`/sections/${sectionId}/images/${imageId}`, params);
  return res.data;
}

export async function deleteSectionImage(sectionId: number, imageId: number): Promise<void> {
  await http.delete(`/sections/${sectionId}/images/${imageId}`);
}

export async function deleteSection(sectionId: number): Promise<void> {
  await http.delete(`/sections/${sectionId}`);
}

export async function verifySection(id: number): Promise<{ is_valid: boolean; flags: string[] }> {
  const res = await http.post<{ is_valid: boolean; flags: string[] }>(`/sections/${id}/verify`);
  return res.data;
}

export async function uploadSectionImage(
  sectionId: number,
  file: Blob | File,
  filename?: string,
): Promise<SectionImage> {
  const form = new FormData();
  // Clipboard images arrive as a nameless Blob — give the multipart part a
  // filename so the backend's UploadFile parses it.
  const name = filename || (file instanceof File ? file.name : 'pasted-image.png');
  form.append('file', file, name);
  const res = await http.post<SectionImage>(`/sections/${sectionId}/images`, form);
  return res.data;
}

// Fetch an image by URL server-side (no browser CORS). Used when an image is
// dragged from another website/app — the browser gives a URL, not file bytes.
export async function uploadSectionImageFromUrl(
  sectionId: number,
  url: string,
): Promise<SectionImage> {
  const res = await http.post<SectionImage>(`/sections/${sectionId}/images/from-url`, { url });
  return res.data;
}

// ─── Review Mark Types ────────────────────────────────────────────────────────

export async function getReviewMarkTypes(): Promise<ReviewMarkType[]> {
  const res = await http.get<ReviewMarkType[]>('/review-marks');
  return res.data;
}

export async function createReviewMarkType(params: {
  name: string;
  color?: string;
  sort_order?: number;
}): Promise<ReviewMarkType> {
  const res = await http.post<ReviewMarkType>('/review-marks', params);
  return res.data;
}

export async function updateReviewMarkType(
  id: number,
  params: { name?: string; color?: string; sort_order?: number }
): Promise<ReviewMarkType> {
  const res = await http.patch<ReviewMarkType>(`/review-marks/${id}`, params);
  return res.data;
}

export async function deleteReviewMarkType(id: number): Promise<void> {
  await http.delete(`/review-marks/${id}`);
}

// ─── Fix Batches ──────────────────────────────────────────────────────────────

export async function getFixBatches(): Promise<FixBatch[]> {
  const res = await http.get<FixBatch[]>('/fix-batches');
  return res.data;
}

export async function getFixBatch(id: number): Promise<FixBatch> {
  const res = await http.get<FixBatch>(`/fix-batches/${id}`);
  return res.data;
}

export async function createFixBatch(params: {
  mark_type_id?: number | null;  // omit for the in-place regenerate→split flow
  card_ids: number[];
  prompt: string;
  model: string;
}): Promise<{ batch_id: number }> {
  const res = await http.post<{ batch_id: number }>('/fix-batches', params);
  return res.data;
}

export async function rerunFixBatch(id: number, prompt: string): Promise<{ batch_id: number }> {
  const res = await http.post<{ batch_id: number }>(`/fix-batches/${id}/rerun`, { prompt });
  return res.data;
}

export async function updateFixProposal(
  batchId: number,
  proposalId: number,
  reviewerAction: string
): Promise<FixProposal> {
  const res = await http.patch<FixProposal>(`/fix-batches/${batchId}/proposals/${proposalId}`, {
    reviewer_action: reviewerAction,
  });
  return res.data;
}

export async function updateFixProposalContent(
  batchId: number,
  proposalId: number,
  content: { proposed_front_html?: string; proposed_extra?: string | null; new_cards_json?: unknown[] }
): Promise<FixProposal> {
  const res = await http.patch<FixProposal>(
    `/fix-batches/${batchId}/proposals/${proposalId}/content`,
    content
  );
  return res.data;
}

export async function confirmFixBatch(
  id: number,
  proposalIds?: number[],
  keepOriginal?: boolean
): Promise<{ confirmed: number; batch_status: string }> {
  const res = await http.post<{ confirmed: number; batch_status: string }>(
    `/fix-batches/${id}/confirm`,
    { proposal_ids: proposalIds ?? null, keep_original: keepOriginal ?? false }
  );
  return res.data;
}

export async function cancelFixBatch(id: number): Promise<void> {
  await http.post(`/fix-batches/${id}/cancel`);
}

export interface CombineProposal {
  front_html: string;
  extra: string | null;
  tags: string[];
  source_card_ids: number[];
}

export async function combinePreview(params: { card_ids: number[]; prompt?: string; model: string }): Promise<CombineProposal> {
  const res = await http.post<CombineProposal>('/cards/combine-preview', params);
  return res.data;
}

export async function combineApply(params: { card_ids: number[]; front_html: string; extra: string | null; tags: string[]; keep_original: boolean; model: string }): Promise<Card> {
  const res = await http.post<Card>('/cards/combine-apply', params);
  return res.data;
}

export async function bulkScoreCards(params: { card_ids: number[]; model: string; card_version?: string }): Promise<{ scored: number }> {
  const res = await http.post<{ scored: number }>('/cards/bulk-score', params);
  return res.data;
}

export async function validateCards(params: { card_ids: number[]; model: string; auto_fix?: boolean; card_version?: string }): Promise<{ validated: number; fixed: number; split: number }> {
  const res = await http.post<{ validated: number; fixed: number; split: number }>('/cards/validate', params);
  return res.data;
}

export interface SectionCost {
  total: number;
  since: string | null;
  by_operation: { operation: string; cost: number }[];
}

export async function getSectionCost(sectionId: number): Promise<SectionCost> {
  const res = await http.get<SectionCost>(`/sections/${sectionId}/cost`);
  return res.data;
}

export async function resetSectionCost(sectionId: number): Promise<{ reset_at: string }> {
  const res = await http.post<{ reset_at: string }>(`/sections/${sectionId}/cost/reset`, {});
  return res.data;
}

export async function getValidationRules(): Promise<{ key: string; title: string; criteria: string }[]> {
  const res = await http.get<{ key: string; title: string; criteria: string }[]>('/cards/validation-rules');
  return res.data;
}

export async function revertValidation(cardId: number, version: string = 'base'): Promise<Card> {
  const res = await http.post<Card>(`/cards/${cardId}/revert-validation`, {}, { params: { version } });
  return res.data;
}

export async function clearValidationMarks(params: { card_ids?: number[]; section_id?: number; section_ids?: number[] }): Promise<{ cleared: number }> {
  const res = await http.post<{ cleared: number }>('/cards/clear-validation-marks', params);
  return res.data;
}

export async function bulkMarkCards(params: {
  card_ids: number[];
  mark_type_id: number | null;
}): Promise<{ updated: number }> {
  const res = await http.post<{ updated: number }>('/fix-batches/bulk-mark', params);
  return res.data;
}

// ─── Cards ───────────────────────────────────────────────────────────────────

export async function getCards(params?: {
  section_id?: number;
  section_ids?: string;
  topic?: string;
  status?: CardStatus;
  is_reviewed?: boolean;
  mark_type_id?: number | null;
  search_q?: string;
  modified_by_validator?: boolean;
  version?: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedCards> {
  const res = await http.get<PaginatedCards>('/cards', {
    params: { limit: 50, offset: 0, ...params },
  });
  return res.data;
}

export async function updateCard(
  id: number,
  params: {
    front_html?: string;
    tags?: string[];
    tags_mapped?: string[];
    extra?: string | null;
    vignette?: string | null;
    teaching_case?: string | null;
    status?: CardStatus;
    is_reviewed?: boolean;
    ref_img?: string | null;
    ref_img_id?: number | null;
    ref_img_position?: 'front' | 'back';
  }
): Promise<Card> {
  const res = await http.patch<Card>(`/cards/${id}`, params);
  return res.data;
}

export async function rejectCard(id: number): Promise<Card> {
  const res = await http.post<Card>(`/cards/${id}/reject`);
  return res.data;
}

// Rephrase a highlighted snippet of a card's front. `text` is the full plain
// card text (for context); `snippet` is the stored HTML of the selection —
// clozes/bold included. The backend preserves that markup and returns the
// reworded snippet in the same stored HTML form.
export async function rewordSnippet(
  text: string,
  snippet: string,
  model?: string,
  guidance?: string
): Promise<{ reworded: string }> {
  const res = await http.post<{ reworded: string }>('/cards/reword', { text, snippet, model, guidance });
  return res.data;
}

export async function regenerateCardPreview(
  id: number,
  params: { model: string; prompt?: string; card_version?: string }
): Promise<{ front_html: string; extra: string | null; source_ref: string | null }> {
  const res = await http.post(`/cards/${id}/regenerate-preview`, params);
  return res.data;
}

export async function deleteCard(id: number): Promise<void> {
  await http.delete(`/cards/${id}`);
}

export interface DebugPromptResult {
  section_heading: string;
  system: string;
  user: string;
}

export interface DebugRunResult {
  model: string;
  raw_response: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number; [k: string]: number };
  cost_usd: number;
}

export async function debugPromptSection(
  sectionId: number,
  params: { rule_set_id?: number | null } = {}
): Promise<DebugPromptResult> {
  const res = await http.post<DebugPromptResult>(`/generate/section/${sectionId}/debug-prompt`, params);
  return res.data;
}

export async function debugRunSection(
  sectionId: number,
  params: { model: string; rule_set_id?: number | null }
): Promise<DebugRunResult> {
  const res = await http.post<DebugRunResult>(`/generate/section/${sectionId}/debug-run`, params);
  return res.data;
}

export async function addManualCards(params: {
  section_id: number;
  cards?: { front_html: string; extra?: string | null; tags?: string[] }[];
  raw_text?: string;
  csv_text?: string;
  card_version?: string;
  include_supplementals?: boolean;
  model: string;
  format?: 'pipe';
  after_card_id?: number;
}): Promise<{ created: Card[] }> {
  const res = await http.post<{ created: Card[] }>('/cards/manual', params);
  return res.data;
}

export async function regenerateCard(
  id: number,
  params: { model?: string; prompt?: string; card_version?: string }
): Promise<Card> {
  const res = await http.post<Card>(`/cards/${id}/regenerate`, params);
  return res.data;
}

export async function bulkMarkReviewed(cardIds: number[], isReviewed = true): Promise<{ updated: number }> {
  const res = await http.post<{ updated: number }>('/cards/bulk-review', { card_ids: cardIds, is_reviewed: isReviewed });
  return res.data;
}

export async function bulkDeleteCards(params: {
  card_ids?: number[];
  section_id?: number;
  section_ids?: number[];
  topic_tree_id?: number;
}): Promise<{ deleted: number }> {
  const res = await http.post<{ deleted: number }>('/cards/bulk-delete', params);
  return res.data;
}

// ─── Generation ──────────────────────────────────────────────────────────────

export async function getModels(): Promise<Model[]> {
  const res = await http.get<Model[]>('/generate/models');
  return res.data;
}

export async function estimateCost(params: {
  topic_tree_id?: number;
  section_ids?: number[];
  topic_path?: string;
  rule_set_id: number;
  model: string;
}): Promise<CostEstimate> {
  const res = await http.post<CostEstimate>('/generate/estimate', params);
  return res.data;
}

export async function startGeneration(params: {
  topic_tree_id?: number;
  section_ids?: number[];
  topic_path?: string;
  rule_set_id: number;
  model: string;
  card_version?: string;
  replace_existing?: boolean;
}): Promise<{ job_id: number }> {
  const res = await http.post<{ job_id: number }>('/generate/start', {
    card_version: 'base',
    ...params,
  });
  return res.data;
}

export async function getGenerationJob(jobId: number): Promise<GenerationJob> {
  const res = await http.get<GenerationJob>(`/generate/jobs/${jobId}`);
  return res.data;
}

export async function cancelGenerationJob(jobId: number): Promise<void> {
  await http.post(`/generate/jobs/${jobId}/cancel`);
}

export async function getActiveJobs(): Promise<GenerationJob[]> {
  const res = await http.get<GenerationJob[]>('/generate/jobs/active');
  return res.data;
}

export async function startSupplemental(params: {
  card_ids?: number[];
  section_id?: number;
  section_ids?: number[];
  rule_set_id?: number;  // omit → backend uses the default vignette rule set
  model: string;
  replace_existing?: boolean;
}): Promise<{ job_id: number }> {
  const res = await http.post<{ job_id: number }>('/generate/supplemental/start', params);
  return res.data;
}

// ─── Rule Sets ───────────────────────────────────────────────────────────────

export async function getRuleSets(ruleType?: string): Promise<RuleSet[]> {
  const params = ruleType ? { rule_type: ruleType } : undefined;
  const res = await http.get<RuleSet[]>('/rules', { params });
  return res.data;
}

export async function createRuleSet(params: {
  name: string;
  content: string;
  is_default?: boolean;
  rule_type?: string;
  card_version?: string;
}): Promise<RuleSet> {
  const res = await http.post<RuleSet>('/rules', params);
  return res.data;
}

export async function updateRuleSet(
  id: number,
  params: { name?: string; content?: string; is_default?: boolean; card_version?: string }
): Promise<RuleSet> {
  const res = await http.patch<RuleSet>(`/rules/${id}`, params);
  return res.data;
}

export async function deleteRuleSet(id: number): Promise<void> {
  await http.delete(`/rules/${id}`);
}

export async function setDefaultRuleSet(id: number): Promise<RuleSet> {
  const res = await http.post<RuleSet>(`/rules/${id}/set-default`);
  return res.data;
}

export async function setRuleShown(id: number, is_shown: boolean): Promise<RuleSet> {
  const res = await http.patch<RuleSet>(`/rules/${id}/set-shown`, { is_shown });
  return res.data;
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function exportCardsUrl(params?: {
  topic_tree_id?: number;
  curriculum_id?: number;
  topic_path?: string;
  card_ids?: number[];
  section_id?: number;
  tag_set?: 'old' | 'new';
  card_version?: string;
}): string {
  const url = new URL('/api/export/cards', window.location.origin);
  if (params?.tag_set) url.searchParams.set('tag_set', params.tag_set);
  if (params?.card_version && params.card_version !== 'base') {
    url.searchParams.set('card_version', params.card_version);
  }
  if (params?.card_ids?.length) {
    url.searchParams.set('card_ids', params.card_ids.join(','));
  } else if (params?.section_id != null) {
    url.searchParams.set('section_id', String(params.section_id));
  } else if (params?.topic_tree_id != null) {
    url.searchParams.set('topic_tree_id', String(params.topic_tree_id));
  } else if (params?.topic_path) {
    url.searchParams.set('topic_path', params.topic_path);
  } else if (params?.curriculum_id != null) {
    url.searchParams.set('curriculum_id', String(params.curriculum_id));
  }
  return url.toString();
}

// ─── Usage ───────────────────────────────────────────────────────────────────

export async function getUsageSummary(): Promise<AIUsageSummary> {
  const res = await http.get<AIUsageSummary>('/usage/summary');
  return res.data;
}

// ─── Chat ────────────────────────────────────────────────────────────────────

export interface ChatSessionSummary {
  id: number;
  name: string;
  app_version: number;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface ChatSessionDetail {
  id: number;
  name: string;
  messages: { role: string; content: string }[];
  app_version: number;
  created_at: string;
  updated_at: string;
}

export async function getChatSessions(): Promise<ChatSessionSummary[]> {
  const res = await http.get<ChatSessionSummary[]>('/chat/sessions');
  return res.data;
}

export async function getChatSession(id: number): Promise<ChatSessionDetail> {
  const res = await http.get<ChatSessionDetail>(`/chat/sessions/${id}`);
  return res.data;
}

export async function deleteChatSession(id: number): Promise<void> {
  await http.delete(`/chat/sessions/${id}`);
}

// ─── Presentations ────────────────────────────────────────────────────────────

export async function getPresentations(): Promise<Presentation[]> {
  const res = await http.get<Presentation[]>('/presentations');
  return res.data;
}

export async function createPresentation(params: {
  name: string;
  card_version: string;
  source_type: string;
  card_ids?: number[] | null;
  topic_tree_id?: number | null;
}): Promise<Presentation> {
  const res = await http.post<Presentation>('/presentations', params);
  return res.data;
}

export async function deletePresentation(id: number): Promise<void> {
  await http.delete(`/presentations/${id}`);
}

export async function getPresentationCards(slug: string): Promise<{ presentation: Presentation; cards: Card[] }> {
  const res = await http.get<{ presentation: Presentation; cards: Card[] }>(`/presentations/${slug}/cards`);
  return res.data;
}

// ─── Chat ────────────────────────────────────────────────────────────────────

export async function sendChatMessage(
  message: string,
  sessionId?: number | null,
  ruleSetId?: number | null,
  vignetteRuleSetId?: number | null
): Promise<{
  content: string;
  session_id: number;
  session_name: string;
  cost_usd: number;
}> {
  const res = await http.post<{
    content: string;
    session_id: number;
    session_name: string;
    cost_usd: number;
  }>('/chat/send', {
    message,
    session_id: sessionId ?? null,
    rule_set_id: ruleSetId ?? null,
    vignette_rule_set_id: vignetteRuleSetId ?? null,
  });
  return res.data;
}

// ── Edit Lab (silent edit-capture + per-card history) ─────────────────────────

export interface LabEvent {
  kind: string;
  field: string;
  front_html: string;
  extra: string | null;
  meta?: unknown;
}

export interface LabHistoryEntry {
  seq: number;
  kind: string;
  field: string;
  front_html: string;
  extra: string | null;
  meta: unknown;
  created_at: string;
}

// Persist a batch of captured edit events for one card (fire-and-forget from the
// caller's side — see CardEditPopup.handleSave, which swallows any failure).
export async function recordEvents(
  sectionId: number,
  cardId: number,
  events: LabEvent[]
): Promise<{ saved: number }> {
  const res = await http.post<{ saved: number }>('/lab/events', {
    section_id: sectionId,
    card_id: cardId,
    events,
  });
  return res.data;
}

// Full edit history for a card (seq ascending; first entry is the origin).
export async function getCardHistory(cardId: number): Promise<LabHistoryEntry[]> {
  const res = await http.get<LabHistoryEntry[]>(`/lab/card/${cardId}/history`);
  return res.data;
}

// ── Lab admin endpoints ────────────────────────────────────────────────────────

export interface LabFinalizationSummary {
  id: number;
  section_id: number;
  section_heading: string | null;
  card_count: number;
  loop_status: string;
  created_at: string | null;
  finished_at: string | null;
}

export interface LabCardEntry {
  card_id: number;
  card_number: number;
  front_html: string;
  extra: string | null;
}

export interface LabSnapshot {
  id: number;
  rule_set_id: number | null;
  model: string | null;
  card_version: string | null;
  cards_json: LabCardEntry[] | null;
  created_at: string | null;
}

export interface LabEditEvent {
  seq: number;
  kind: string;
  field: string | null;
  front_html: string | null;
  extra: string | null;
  meta: unknown;
  created_at: string | null;
}

export interface LabFinalization {
  id: number;
  loop_status: string;
  cards_json: LabCardEntry[] | null;
  created_at: string | null;
  finished_at: string | null;
}

export interface LabSectionDetail {
  section_id: number;
  section_heading: string | null;
  latest_snapshot: LabSnapshot | null;
  events_by_card: Record<string, LabEditEvent[]>;
  latest_finalization: LabFinalization | null;
}

// List all section finalizations (newest first).
export async function getLabSections(): Promise<LabFinalizationSummary[]> {
  const res = await http.get<LabFinalizationSummary[]>('/lab/sections');
  return res.data;
}

// Full detail for a section: latest snapshot, all edit events by card, latest finalization.
export async function getLabSection(sectionId: number): Promise<LabSectionDetail> {
  const res = await http.get<LabSectionDetail>(`/lab/section/${sectionId}`);
  return res.data;
}

// Snapshot the section's current active cards into a SectionFinalization.
export async function finalizeSection(sectionId: number): Promise<LabFinalization> {
  const res = await http.post<LabFinalization>(`/lab/finalize/${sectionId}`);
  return res.data;
}

// Flip a finalization's loop_status to 'running'.
export async function startFinalization(finalizationId: number): Promise<{ id: number; section_id: number; loop_status: string }> {
  const res = await http.post<{ id: number; section_id: number; loop_status: string }>(`/lab/finalizations/${finalizationId}/start`);
  return res.data;
}

// ── Step-by-Step (SBS) generation ─────────────────────────────────────────────
import type { SbsRuleSet, SbsPreview, SbsJob } from './types';

export async function listSbsRules(): Promise<SbsRuleSet[]> {
  return (await http.get<SbsRuleSet[]>('/sbs/rules')).data;
}
export async function createSbsRule(name: string, sections: SbsRuleSet['sections']): Promise<SbsRuleSet> {
  return (await http.post<SbsRuleSet>('/sbs/rules', { name, sections })).data;
}
export async function updateSbsRule(id: number, patch: Partial<Pick<SbsRuleSet, 'name' | 'sections' | 'is_default'>>): Promise<SbsRuleSet> {
  return (await http.patch<SbsRuleSet>(`/sbs/rules/${id}`, patch)).data;
}
export async function deleteSbsRule(id: number): Promise<void> {
  await http.delete(`/sbs/rules/${id}`);
}
export async function sbsPreview(sectionId: number, sbsRuleSetId: number): Promise<SbsPreview> {
  return (await http.post<SbsPreview>('/sbs/preview', { section_id: sectionId, sbs_rule_set_id: sbsRuleSetId })).data;
}
export async function startSbs(params: { section_id: number; sbs_rule_set_id: number; card_version: string; model: string }): Promise<SbsJob> {
  return (await http.post<SbsJob>('/sbs/start', params)).data;
}
export async function getSbsJob(id: number): Promise<SbsJob> {
  return (await http.get<SbsJob>(`/sbs/jobs/${id}`)).data;
}
export function sbsReportUrl(jobId: number): string {
  return `/api/sbs/jobs/${jobId}/report`;
}

// ── Generate & Verify ─────────────────────────────────────────────────────────
import type { VerifyJob } from './types';

export async function startVerify(params: { section_id: number; rule_set_id?: number | null; card_version: string; model: string }): Promise<VerifyJob> {
  return (await http.post<VerifyJob>('/verify/start', params)).data;
}
export async function getVerifyJob(id: number): Promise<VerifyJob> {
  return (await http.get<VerifyJob>(`/verify/jobs/${id}`)).data;
}
export function verifyReportUrl(jobId: number): string {
  return `/api/verify/jobs/${jobId}/report`;
}
