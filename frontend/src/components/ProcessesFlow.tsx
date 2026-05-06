import { useState, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// ─── Custom Node Types ───────────────────────────────────────────────────────

function StepNode({ data }: { data: Record<string, unknown> }) {
  const d = data as { label: string; description: string; icon: string; aiPowered?: boolean; info?: string };
  return (
    <div className={`px-4 py-3 rounded-xl border-2 shadow-md min-w-[220px] max-w-[280px] bg-white ${d.aiPowered ? 'border-purple-300' : 'border-gray-200'}`}>
      <Handle type="target" position={Position.Top} className="!bg-gray-400 !w-2 !h-2" />
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-lg">{d.icon}</span>
        <span className="text-sm font-semibold text-gray-900">{d.label}</span>
        {d.aiPowered && <span className="text-[9px] font-bold text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded-full">AI</span>}
      </div>
      <p className="text-[11px] text-gray-500 leading-relaxed">{d.description}</p>
      {d.info && <p className="text-[10px] text-blue-600 mt-1.5 leading-snug border-t border-gray-100 pt-1.5">{d.info}</p>}
      <Handle type="source" position={Position.Bottom} className="!bg-gray-400 !w-2 !h-2" />
    </div>
  );
}

function DecisionNode({ data }: { data: Record<string, unknown> }) {
  const d = data as { label: string; description: string };
  return (
    <div className="relative">
      <Handle type="target" position={Position.Top} className="!bg-amber-500 !w-2 !h-2" />
      <div className="bg-amber-50 border-2 border-amber-300 rounded-lg px-4 py-2.5 shadow-md min-w-[180px] max-w-[220px] text-center">
        <span className="text-sm font-semibold text-amber-800">{d.label}</span>
        <p className="text-[10px] text-amber-600 mt-1">{d.description}</p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-amber-500 !w-2 !h-2" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-amber-500 !w-2 !h-2" />
    </div>
  );
}

function InfoNode({ data }: { data: Record<string, unknown> }) {
  const d = data as { label: string; items: string[] };
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 shadow-sm max-w-[240px]">
      <Handle type="target" position={Position.Left} className="!bg-blue-400 !w-2 !h-2" />
      <span className="text-xs font-semibold text-blue-800 block mb-1">{d.label}</span>
      <ul className="space-y-0.5">
        {d.items.map((item, i) => (
          <li key={i} className="text-[10px] text-blue-600 flex items-start gap-1">
            <span className="text-blue-400 mt-0.5">•</span>{item}
          </li>
        ))}
      </ul>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  step: StepNode as any,
  decision: DecisionNode as any,
  info: InfoNode as any,
};

const edge = (id: string, source: string, target: string, opts?: Partial<Edge>): Edge => ({
  id,
  source,
  target,
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: '#94a3b8' },
  style: { stroke: '#94a3b8', strokeWidth: 1.5 },
  ...opts,
});

const greenEdge = { style: { stroke: '#16a34a', strokeWidth: 1.5 } };
const dashedEdge = { style: { stroke: '#d97706', strokeWidth: 1.5, strokeDasharray: '5 5' } };
const infoEdge = { style: { stroke: '#3b82f6', strokeWidth: 1.5, strokeDasharray: '4 4' } };

// ─── Process Definitions ────────────────────────────────────────────────────

interface ProcessDef {
  id: string;
  label: string;
  icon: string;
  description: string;
  nodes: Node[];
  edges: Edge[];
}

const PROCESSES: ProcessDef[] = [
  {
    id: 'main',
    label: 'Main Flow',
    icon: '🔄',
    description: 'The complete workflow from uploading a document to exporting Anki cards.',
    nodes: [
      { id: 'upload', type: 'step', position: { x: 250, y: 0 }, data: { icon: '📄', label: 'Upload or Paste', description: 'Upload a .docx file or paste HTML from Word, Google Docs, Pages.', info: 'Images are extracted and stored. Document is saved to the system.' } },
      { id: 'chunking', type: 'step', position: { x: 250, y: 170 }, data: { icon: '✂️', label: 'Semantic Chunking', description: 'AI splits the document into meaningful chunks based on content structure and topic boundaries.', aiPowered: true, info: 'Uses Haiku (fixed). Identifies headings, bullet lists, tables, images.' } },
      { id: 'topics', type: 'step', position: { x: 250, y: 360 }, data: { icon: '🏷️', label: 'Topic Detection', description: 'AI matches each chunk to the most relevant topic in your curriculum tree.', aiPowered: true, info: 'Uses Haiku. Results are suggestions — you review them next.' } },
      { id: 'review', type: 'step', position: { x: 250, y: 540 }, data: { icon: '👁️', label: 'Review Topics', description: 'See each chunk with its AI-suggested topic. Adjust any that are wrong using the topic picker.', info: 'Topics determine the tags on cards. Can be reassigned later from the curriculum sidebar.' } },
      { id: 'decide_gen', type: 'decision', position: { x: 280, y: 720 }, data: { label: 'Generate Cards?', description: '"Generate now" or "Later"' } },
      { id: 'skip_info', type: 'info', position: { x: 560, y: 720 }, data: { label: 'Skip for Later', items: ['Chunks saved with topics', 'Generate anytime from document view', 'Select chunks → Generate'] } },
      { id: 'card_gen', type: 'step', position: { x: 250, y: 900 }, data: { icon: '🃏', label: 'Card Generation', description: 'AI generates Anki cloze cards from each chunk. The anchor term (condition name) is never clozed.', aiPowered: true, info: 'Uses your Generation Model + Rules. Sibling chunks sent as context. Each card gets a unique note_id.' } },
      { id: 'gen_ctx', type: 'info', position: { x: 560, y: 900 }, data: { label: 'AI Context', items: ['Chunk source text + heading', 'Topic path (curriculum)', 'Sibling chunks (same topic)', 'Your generation rules', 'Anchor instruction (hardcoded)'] } },
      { id: 'decide_supp', type: 'decision', position: { x: 280, y: 1100 }, data: { label: 'Generate Vignettes & Cases?', description: 'Optional — can do later from cards table' } },
      { id: 'supp_gen', type: 'step', position: { x: 250, y: 1280 }, data: { icon: '📋', label: 'Vignette + Teaching Case', description: 'AI generates ONE shared vignette + ONE teaching case per condition. All cards for the same condition get identical content.', aiPowered: true, info: 'Cards grouped by leaf topic (condition). One API call per group. Uses your Vignette + TC Rules.' } },
      { id: 'supp_ctx', type: 'info', position: { x: 560, y: 1280 }, data: { label: 'AI Context', items: ['All card fronts for the condition', 'Condition/topic name', 'Your vignette + TC rules', 'Does NOT use chunk source text', 'Uses AI medical knowledge'] } },
      { id: 'review_cards', type: 'step', position: { x: 250, y: 1480 }, data: { icon: '✏️', label: 'Review & Edit Cards', description: 'Edit front text, tags, vignettes, teaching cases inline. Toggle ref images front/back. Mark reviewed, reject, regenerate.', info: 'Use Ankify mode to preview the study experience before exporting.' } },
      { id: 'export', type: 'step', position: { x: 250, y: 1680 }, data: { icon: '📤', label: 'Export to Anki', description: 'Export as CSV with note_id, front, tags, vignette, teaching case, ref_img.', info: 'note_id ensures Anki updates existing cards on re-import (no duplicates).' } },
    ],
    edges: [
      edge('e1', 'upload', 'chunking'),
      edge('e2', 'chunking', 'topics'),
      edge('e3', 'topics', 'review'),
      edge('e4', 'review', 'decide_gen'),
      edge('e5', 'decide_gen', 'card_gen', { label: 'Yes', ...greenEdge }),
      edge('e5b', 'decide_gen', 'skip_info', { sourceHandle: 'right', ...dashedEdge }),
      edge('e6', 'card_gen', 'gen_ctx', infoEdge),
      edge('e7', 'card_gen', 'decide_supp'),
      edge('e8', 'decide_supp', 'supp_gen', { label: 'Yes', ...greenEdge }),
      edge('e8b', 'decide_supp', 'review_cards', { sourceHandle: 'right', label: 'Skip', type: 'smoothstep', ...dashedEdge }),
      edge('e9', 'supp_gen', 'supp_ctx', infoEdge),
      edge('e10', 'supp_gen', 'review_cards'),
      edge('e11', 'review_cards', 'export'),
    ],
  },
  {
    id: 'settings',
    label: 'Settings & Rules',
    icon: '⚙️',
    description: 'How to configure AI models and prompt rules before generating content.',
    nodes: [
      { id: 'settings', type: 'step', position: { x: 250, y: 0 }, data: { icon: '⚙️', label: 'Open Settings', description: 'Click the gear icon in the top-right navbar. Settings are saved to your browser (localStorage).', info: 'Check settings before your first generation to ensure correct model and rules are selected.' } },
      { id: 'card_model', type: 'step', position: { x: 100, y: 200 }, data: { icon: '🤖', label: 'Card Generation Model', description: 'Which AI model generates cloze cards. Sonnet recommended for quality.', info: 'More expensive models may produce better cards. Haiku is cheaper but less nuanced.' } },
      { id: 'card_rules', type: 'step', position: { x: 400, y: 200 }, data: { icon: '📝', label: 'Card Generation Rules', description: 'The prompt template that tells AI how to create cloze cards.', info: 'Dropdown shows rule sets of type "Generation". Select one or use default.' } },
      { id: 'supp_model', type: 'step', position: { x: 100, y: 400 }, data: { icon: '🤖', label: 'Vignette + TC Model', description: 'Which AI model generates vignettes and teaching cases. Sonnet recommended.', info: 'This model generates both vignette AND teaching case in one call per condition.' } },
      { id: 'supp_rules', type: 'step', position: { x: 400, y: 400 }, data: { icon: '📝', label: 'Vignette + TC Rules', description: 'The prompt template for vignettes and teaching cases. This is where you paste the detailed generation instructions.', info: 'One combined prompt generates both Column 5 (vignette) and Column 6 (teaching case).' } },
      { id: 'manage_rules', type: 'step', position: { x: 250, y: 600 }, data: { icon: '📚', label: 'Manage Rules (Library > Rules)', description: 'Create, edit, delete rule sets. Two tabs: Generation and Vignette + Teaching Case.', info: 'Set one default per type. Click a rule in the sidebar to edit it inline on the right panel. Create new rules with "+ New".' } },
    ],
    edges: [
      edge('e1', 'settings', 'card_model'),
      edge('e2', 'settings', 'card_rules'),
      edge('e3', 'settings', 'supp_model'),
      edge('e4', 'settings', 'supp_rules'),
      edge('e5', 'card_rules', 'manage_rules'),
      edge('e6', 'supp_rules', 'manage_rules'),
    ],
  },
  {
    id: 'curriculum',
    label: 'Curriculum & Topics',
    icon: '🌳',
    description: 'How to manage the topic tree, assign topics to chunks, and reorganize.',
    nodes: [
      { id: 'tree', type: 'step', position: { x: 250, y: 0 }, data: { icon: '🌳', label: 'Curriculum Tree', description: 'Hierarchical topic structure in the Workspace sidebar. Example: Emergency Medicine > Cardiovascular > Atrial Fibrillation.', info: 'Toggle edit mode (pencil icon) to add, rename, or delete topics. Topics at any level can have chunks assigned.' } },
      { id: 'add_topic', type: 'step', position: { x: 50, y: 200 }, data: { icon: '➕', label: 'Add Topic', description: 'Click "+ Add topic" at the bottom of the tree (in edit mode) for top-level, or the + button on a topic for a child.', info: 'Leaf topics (deepest level) = conditions. These become card tags and determine vignette/TC grouping.' } },
      { id: 'rename', type: 'step', position: { x: 450, y: 200 }, data: { icon: '✏️', label: 'Rename Topic', description: 'Click a topic name in edit mode to rename it. Path and tags update automatically for all children and cards.', info: 'Renaming cascades: if you rename "Cardio" to "Cardiovascular", all children paths update too.' } },
      { id: 'delete', type: 'step', position: { x: 50, y: 400 }, data: { icon: '🗑️', label: 'Delete Topic', description: 'Delete a leaf topic. Chunks are reassigned to the parent topic. The deleted topic name is removed from card tags.', info: 'Cannot delete topics with children — delete children first. Chunks move up one level.' } },
      { id: 'reassign', type: 'step', position: { x: 450, y: 400 }, data: { icon: '🔄', label: 'Reassign Topics', description: 'Re-run AI topic detection for chunks under a topic. Use when curriculum changes or initial assignments were wrong.', aiPowered: true, info: 'Click "Reassign" on a topic. AI suggests new assignments. Review each chunk and confirm. Card tags update automatically.' } },
      { id: 'impact', type: 'info', position: { x: 250, y: 600 }, data: { label: 'Topic changes affect', items: ['Card tags (derived from topic path)', 'Vignette/TC grouping (by leaf topic)', 'Document filtering in Library', 'Coverage statistics', 'Export tags in CSV'] } },
    ],
    edges: [
      edge('e1', 'tree', 'add_topic'),
      edge('e2', 'tree', 'rename'),
      edge('e3', 'add_topic', 'delete'),
      edge('e4', 'rename', 'reassign'),
      edge('e5', 'delete', 'impact'),
      edge('e6', 'reassign', 'impact'),
    ],
  },
  {
    id: 'documents',
    label: 'Document Management',
    icon: '📚',
    description: 'Where to find, browse, and manage uploaded documents.',
    nodes: [
      { id: 'upload', type: 'step', position: { x: 250, y: 0 }, data: { icon: '📤', label: 'Upload or Paste', description: 'In Workspace: use the Upload (.docx) or Paste (clipboard HTML) buttons in the sidebar.', info: 'Paste supports Word, Google Docs, Pages. Images are captured from .docx files.' } },
      { id: 'library', type: 'step', position: { x: 250, y: 180 }, data: { icon: '📚', label: 'Library > Documents', description: 'View all documents with chunk counts and card counts. Filter by topic. Click to navigate to the document in Workspace.', info: 'Rename documents by clicking the name. Delete documents (cascades to chunks and cards).' } },
      { id: 'workspace', type: 'step', position: { x: 250, y: 360 }, data: { icon: '📂', label: 'Workspace Document View', description: 'Select a document in the sidebar to see its chunks on the left and cards on the right.', info: 'Click "Browse chunks" on a document to see all its chunks. Click a chunk to filter cards from that chunk.' } },
      { id: 'chunks', type: 'step', position: { x: 250, y: 540 }, data: { icon: '🧩', label: 'Chunk Browser', description: 'Each chunk shows its heading, content preview, topic assignment, and card count. Click the info icon on a card to see its source chunk.', info: 'Chunks contain the original text + images. The AI generates cards FROM chunks. Changing a chunk\'s topic changes its cards\' tags.' } },
    ],
    edges: [
      edge('e1', 'upload', 'library'),
      edge('e2', 'library', 'workspace'),
      edge('e3', 'workspace', 'chunks'),
    ],
  },
  {
    id: 'cards',
    label: 'Card Review & Edit',
    icon: '✏️',
    description: 'How to review, edit, and manage generated cards.',
    nodes: [
      { id: 'table', type: 'step', position: { x: 250, y: 0 }, data: { icon: '📊', label: 'Cards Table', description: 'All cards for the selected document/topic. Columns: #, Front, Tags, Ref Image, Vignette, Teaching Case.', info: 'Toggle optional columns with "Columns" button. Ref Image, Vignette, Teaching Case are hidden by default.' } },
      { id: 'edit', type: 'step', position: { x: 50, y: 200 }, data: { icon: '✏️', label: 'Inline Editing', description: 'Double-click any cell to edit. Tab to save, Escape to cancel. Tags have pill-style editing with add/remove.', info: 'Vignette and Teaching Case cells are clamped to 4 lines. Double-click to expand and edit the full text.' } },
      { id: 'actions', type: 'step', position: { x: 450, y: 200 }, data: { icon: '⚡', label: 'Card Actions', description: 'Select cards with checkboxes. Available actions: Mark reviewed, Generate Vignettes & Cases, Regenerate.', info: 'Regenerate a single card: click the refresh icon, optionally add guidance text. The AI regenerates from the original chunk.' } },
      { id: 'ref_img', type: 'step', position: { x: 50, y: 400 }, data: { icon: '🖼️', label: 'Reference Images', description: 'Images from the source document. Toggle between Front (shown with question) and Back (shown after reveal).', info: 'Enable the "Ref Image" column from the Columns menu. Click Front/Back buttons to switch placement.' } },
      { id: 'ankify', type: 'step', position: { x: 450, y: 400 }, data: { icon: '🎴', label: 'Ankify Preview', description: 'Click "Ankify" to preview cards as they\'ll appear in Anki. See cloze blanks, reveal answers, view vignette and teaching case.', info: 'Select cards first to ankify only those, or ankify all. Rate cards: Again, Hard, Good, Easy. Navigate with keyboard.' } },
      { id: 'supp_gen', type: 'step', position: { x: 250, y: 600 }, data: { icon: '📋', label: 'Generate Vignettes & Cases', description: 'Select cards → click "Generate Vignettes & Cases". Cards are grouped by condition. Each group gets one shared vignette + teaching case.', aiPowered: true, info: 'Use "Regenerate" for cards that already have content. Cost shown before confirming. Progress tracked per condition group.' } },
    ],
    edges: [
      edge('e1', 'table', 'edit'),
      edge('e2', 'table', 'actions'),
      edge('e3', 'edit', 'ref_img'),
      edge('e4', 'actions', 'ankify'),
      edge('e5', 'ref_img', 'supp_gen'),
      edge('e6', 'ankify', 'supp_gen'),
    ],
  },
];

// ─── Component ───────────────────────────────────────────────────────────────

export default function ProcessesFlow() {
  const [activeProcess, setActiveProcess] = useState('main');
  const process = PROCESSES.find(p => p.id === activeProcess) ?? PROCESSES[0];
  const onInit = useCallback(() => {}, []);

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-56 border-r border-gray-200 bg-gray-50 flex flex-col shrink-0">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Processes</h3>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {PROCESSES.map(p => (
            <button
              key={p.id}
              onClick={() => setActiveProcess(p.id)}
              className={[
                'w-full text-left px-4 py-2.5 flex items-center gap-2.5 transition-colors duration-150',
                activeProcess === p.id
                  ? 'bg-blue-50 text-blue-700 border-r-2 border-blue-600'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
              ].join(' ')}
            >
              <span className="text-base">{p.icon}</span>
              <span className="text-sm font-medium">{p.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Flow area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-200 bg-white">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <span>{process.icon}</span>
            {process.label}
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">{process.description}</p>
        </div>
        {/* Diagram */}
        <div className="flex-1">
          <ReactFlow
            key={activeProcess}
            nodes={process.nodes}
            edges={process.edges}
            nodeTypes={nodeTypes}
            onInit={onInit}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnScroll
            zoomOnScroll
            minZoom={0.3}
            maxZoom={1.5}
          >
            <Background color="#e5e7eb" gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}
