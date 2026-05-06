import axios from 'axios';
import type {
  CurriculumNode,
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
} from './types';

const http = axios.create({ baseURL: '/api' });

// ─── Curriculum ───────────────────────────────────────────────────────────────

export async function getCurriculum(): Promise<CurriculumNode[]> {
  const res = await http.get<CurriculumNode[]>('/curriculum');
  return res.data;
}

export async function getCurriculumCoverage(): Promise<Record<string, TopicCoverageStats>> {
  const res = await http.get<Record<string, TopicCoverageStats>>('/curriculum/coverage');
  return res.data;
}

export async function createCurriculumNode(params: {
  name: string;
  parent_id?: number | null;
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
  topicTreeId?: number
): Promise<{ upload_id: number; processing_job_id: number }> {
  const form = new FormData();
  form.append('file', file);
  if (topicTreeId != null) form.append('topic_tree_id', String(topicTreeId));
  const res = await http.post<{ upload_id: number; processing_job_id: number }>(
    '/topic-trees/upload',
    form
  );
  return res.data;
}

export async function pasteDocument(
  html: string,
  name: string,
  topicTreeId?: number
): Promise<{ upload_id: number; processing_job_id: number }> {
  const res = await http.post<{ upload_id: number; processing_job_id: number }>(
    '/topic-trees/paste',
    { html, name, topic_tree_id: topicTreeId ?? null }
  );
  return res.data;
}

export async function deleteTopicTree(id: number): Promise<void> {
  await http.delete(`/topic-trees/${id}`);
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
  params: { heading?: string; curriculum_topic_id?: number | null; is_verified?: boolean }
): Promise<Section> {
  const res = await http.patch<Section>(`/sections/${id}`, params);
  return res.data;
}

export async function verifySection(id: number): Promise<{ is_valid: boolean; flags: string[] }> {
  const res = await http.post<{ is_valid: boolean; flags: string[] }>(`/sections/${id}/verify`);
  return res.data;
}

// ─── Cards ───────────────────────────────────────────────────────────────────

export async function getCards(params?: {
  section_id?: number;
  topic?: string;
  status?: CardStatus;
  is_reviewed?: boolean;
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

export async function bulkMarkReviewed(cardIds: number[]): Promise<{ updated: number }> {
  const res = await http.post<{ updated: number }>('/cards/bulk-review', { card_ids: cardIds });
  return res.data;
}

export async function bulkDeleteCards(cardIds: number[]): Promise<{ deleted: number }> {
  const res = await http.post<{ deleted: number }>('/cards/bulk-delete', { card_ids: cardIds });
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

export async function getActiveJobs(): Promise<GenerationJob[]> {
  const res = await http.get<GenerationJob[]>('/generate/jobs/active');
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
}): Promise<RuleSet> {
  const res = await http.post<RuleSet>('/rules', params);
  return res.data;
}

export async function updateRuleSet(
  id: number,
  params: { name?: string; content?: string; is_default?: boolean }
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
}): string {
  const url = new URL('/api/export/cards', window.location.origin);
  if (params?.topic_tree_id != null) {
    url.searchParams.set('topic_tree_id', String(params.topic_tree_id));
  }
  if (params?.curriculum_id != null) {
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
