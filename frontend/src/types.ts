export interface CurriculumNode {
  id: number;
  name: string;
  parent_id: number | null;
  level: number;
  path: string;
  sort_order: number;
  children: CurriculumNode[];
}

export interface CurriculumMapping {
  id: number;
  from_node_id: number;
  to_node_id: number;
  from_path: string | null;
  to_path: string | null;
  created_at: string;
}

export interface TopicCoverageStats {
  total: number;
  active: number;
  rejected: number;
  unreviewed: number;
  sections_total?: number;
  sections_done?: number;
}

export interface TopicTree {
  id: number;
  name: string;
  slug: string;
  curriculum_id: number | null;
  section_count: number;
  total_cards: number;
  created_at: string;
  sections?: Section[];
}

export interface Section {
  id: number;
  topic_tree_id: number;
  heading: string;
  slug: string;
  heading_tree: unknown; // nested H3/H4 JSON
  content_text: string;
  content_html: string;
  curriculum_topic_id: number | null;
  curriculum_topic_path: string | null;
  image_count: number;
  table_count: number;
  flags: string[] | null;
  is_verified: boolean;
  is_done: boolean;
  section_status: 'normal' | 'green' | 'orange';
  card_count: number;
  sort_order: number;
}

export interface ContentBlock {
  id: number;
  section_id: number;
  upload_id: number;
  text: string;
  html: string;
  block_type: 'paragraph' | 'heading' | 'table' | 'image_text';
  heading_context: string;
  position: number;
  is_duplicate: boolean;
}

export interface SectionImage {
  id: number;
  section_id: number;
  data_uri: string;
  category: 'decorative' | 'diagram' | 'chart' | 'table_image' | 'unclear';
  extracted_text: string | null;
  alt_text_hint: string | null;
  position: number;
}

export interface Upload {
  id: number;
  topic_tree_id: number;
  original_name: string;
  status: 'processing' | 'ready' | 'error' | 'merged';
  uploaded_at: string;
}

export interface Card {
  id: number;
  section_id: number;
  card_number: number;
  front_html: string;
  front_html_v1: string | null;
  front_html_v2: string | null;
  front_html_v3: string | null;
  front_text: string;
  tags: string[];
  tags_mapped: string[] | null;
  extra: string | null;
  vignette: string | null;
  teaching_case: string | null;
  source_ref: string | null;
  ref_img: string | null;
  ref_img_id: number | null;
  ref_img_position: 'front' | 'back';
  note_id: number;
  status: CardStatus;
  needs_review: boolean;
  is_reviewed: boolean;
  review_mark_id: number | null;
  accuracy_score: number | null;
  accuracy_note: string | null;
  eor_yield: Record<string, string> | null;
  in_fix_batch: boolean;
  created_at: string;
  updated_at: string;
  // for display
  topic_path?: string;
  chunk_id?: number; // alias for section_id for compat
}

export type CardStatus = 'active' | 'rejected';

export interface RuleSet {
  id: number;
  name: string;
  rule_type: 'generation' | 'vignette';
  card_version: 'base' | 'v1' | 'v2' | 'v3';
  content: string;
  is_default: boolean;
  created_at?: string;
}

export interface Presentation {
  id: number;
  name: string;
  slug: string;
  card_version: 'base' | 'v1' | 'v2' | 'v3';
  source_type: 'cards' | 'topic';
  card_ids: number[] | null;
  topic_tree_id: number | null;
  created_at: string;
}

export interface Model {
  id: string;
  display: string;
  input_per_1m: number;
  output_per_1m: number;
}

export interface GenerationJob {
  id: number;
  job_type: string;
  section_id: number | null;
  topic_tree_id: number | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  total_sections: number;
  processed_sections: number;
  total_cards: number;
  pipeline_step: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface ProcessingJob {
  id: number;
  upload_id: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  pipeline_step: string | null;
  error_message: string | null;
}

export interface PaginatedCards {
  cards: Card[];
  total: number;
  limit: number;
  offset: number;
}

export interface CostEstimate {
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number;
}

export interface AIUsageSummary {
  total_cost_usd: number;
  by_operation: Record<string, { count: number; input_tokens: number; output_tokens: number; cost_usd: number }>;
}

export type PipelineStep = 'parsing' | 'images' | 'tables' | 'comparing' | 'merging' | 'done' | null;

export interface CurriculumSection {
  id: number;
  topic_tree_id: number;
  topic_tree_name: string | null;
  heading: string;
  slug: string;
  curriculum_topic_id: number | null;
  curriculum_topic_path: string | null;
  image_count: number;
  table_count: number;
  flags: string[] | null;
  is_verified: boolean;
  is_done: boolean;
  section_status: 'normal' | 'green' | 'orange';
  sort_order: number;
  card_count: number;
}

export interface SectionDetail extends Section {
  content_blocks: ContentBlock[];
  images: SectionImage[];
  uploads: Upload[];
}

export interface ReviewMarkType {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  created_at?: string;
}

export interface FixBatch {
  id: number;
  mark_type_id: number | null;
  mark_type_name: string | null;
  mark_type_color: string | null;
  prompt: string;
  model: string;
  status: 'pending' | 'running' | 'done' | 'confirmed' | 'cancelled';
  total_cards: number;
  processed_cards: number;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
  proposals?: FixProposal[];
}

export interface FixProposal {
  id: number;
  batch_id: number;
  original_card_id: number;
  original_front_html?: string;
  original_extra?: string | null;
  original_tags?: string[];
  original_section_id?: number;
  ai_action: 'edit' | 'keep' | 'delete' | 'split';
  proposed_front_html: string | null;
  proposed_extra: string | null;
  new_cards_json: Array<{ front_html: string; extra: string | null; tags: string[] }> | null;
  reviewer_action: 'edit' | 'keep' | 'delete' | 'split' | null;
  is_resolved: boolean;
  in_fix_batch?: boolean;
}
