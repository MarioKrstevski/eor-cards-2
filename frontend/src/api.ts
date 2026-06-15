import axios from 'axios';
import type {
  CurriculumNode,
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
} from './types';

const http = axios.create({ baseURL: '/api' });

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
  params: { name: string }
): Promise<CurriculumNode> {
  const res = await http.patch<CurriculumNode>(`/curriculum/${id}`, params);
  return res.data;
}

export async function deleteCurriculumNode(id: number): Promise<void> {
  await http.delete(`/curriculum/${id}`);
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

export async function uploadDocument(
  file: File,
  opts?: { topicTreeId?: number; topicTreeName?: string; curriculumId?: number }
): Promise<{ upload_id: number; processing_job_id: number }> {
  const form = new FormData();
  form.append('file', file);
  if (opts?.topicTreeId != null) form.append('topic_tree_id', String(opts.topicTreeId));
  if (opts?.topicTreeName) form.append('topic_tree_name', opts.topicTreeName);
  if (opts?.curriculumId != null) form.append('curriculum_id', String(opts.curriculumId));
  const res = await http.post<{ upload_id: number; processing_job_id: number }>(
    '/topic-trees/upload',
    form
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
  params: { heading?: string; curriculum_topic_id?: number | null; curriculum_topic_path?: string | null; is_verified?: boolean; section_status?: string }
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
  mark_type_id: number;
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
  proposalIds?: number[]
): Promise<{ confirmed: number; batch_status: string }> {
  const res = await http.post<{ confirmed: number; batch_status: string }>(
    `/fix-batches/${id}/confirm`,
    { proposal_ids: proposalIds ?? null }
  );
  return res.data;
}

export async function cancelFixBatch(id: number): Promise<void> {
  await http.post(`/fix-batches/${id}/cancel`);
}

export async function bulkScoreCards(params: { card_ids: number[]; model: string }): Promise<{ scored: number }> {
  const res = await http.post<{ scored: number }>('/cards/bulk-score', params);
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

export async function deleteCard(id: number): Promise<void> {
  await http.delete(`/cards/${id}`);
}

export async function regenerateCard(
  id: number,
  params: { model?: string; prompt?: string }
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
  rule_set_id: number;
  model: string;
}): Promise<CostEstimate> {
  const res = await http.post<CostEstimate>('/generate/estimate', params);
  return res.data;
}

export async function startGeneration(params: {
  topic_tree_id?: number;
  section_ids?: number[];
  rule_set_id: number;
  model: string;
  replace_existing?: boolean;
}): Promise<{ job_id: number }> {
  const res = await http.post<{ job_id: number }>('/generate/start', params);
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

// ─── Export ──────────────────────────────────────────────────────────────────

export function exportCardsUrl(params?: {
  topic_tree_id?: number;
  curriculum_id?: number;
  topic_path?: string;
  card_ids?: number[];
}): string {
  const url = new URL('/api/export/cards', window.location.origin);
  if (params?.card_ids?.length) {
    url.searchParams.set('card_ids', params.card_ids.join(','));
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
