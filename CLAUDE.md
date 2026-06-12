# EOR Card Studio v4 — CLAUDE.md

## Project Purpose
A tool for generating Anki-style cloze flashcards from medical study documents (.docx). Built for a PA (Physician Assistant) exam prep client. V4 is a ground-up rebuild from v3, with a fundamentally different architecture: documents are processed into a growing "master topic tree" per subject, with semantic duplicate detection and merge capabilities. Cards are generated per-section with full heading context.

## Architecture Overview
- **Topic Trees** — Each H1 main topic (e.g., "Cardiology") has ONE master content tree that grows as documents are uploaded
- **Sections** — Each H2 subtopic becomes a Section with nested H3/H4 content
- **Content Blocks** — Individual paragraphs with upload provenance tracking
- **Merge Model** — Subsequent uploads for the same topic get compared, duplicates detected (AI semantic), new content merged in at the correct position
- **Card Generation** — Per-section, with full heading tree context, producing cards + extra + vignettes + teaching cases in one shot

## Tech Stack
- **Backend**: FastAPI + SQLAlchemy 2.0 + SQLite + Anthropic Python SDK
- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS v4 + TanStack Table
- **AI**: Claude Sonnet 4.6 for card generation + vision classification + duplicate detection; Haiku 4.5 available for lighter tasks
- **Doc Parsing**: python-docx for .docx, BeautifulSoup for pasted HTML
- **Dev**: Python 3.12 venv, Node 24, Vite dev server proxying `/api` to FastAPI on :8000

## Development Commands
```bash
# Backend (from /v4/)
cd "/Users/mario/Documents/work/frex-solutions/client-projects/zhanna-related/eor-guide-to-cards/v4" && PYTHONPATH=. .venv/bin/uvicorn backend.main:app --reload  # on :8000

# Frontend (from /v4/frontend/)
cd frontend && npm run dev   # on :5173
```

## Repository Layout
```
v4/
├── backend/
│   ├── main.py              # FastAPI app, router mounts, seed data, admin endpoints
│   ├── models.py            # SQLAlchemy ORM models (see schema below)
│   ├── db.py                # Engine + SessionLocal + Base
│   ├── config.py            # ANTHROPIC_API_KEY, MODELS dict, DEFAULT_MODEL, compute_cost
│   ├── routers/
│   │   ├── documents.py     # Upload/paste, list topic trees, process pipeline, delete
│   │   ├── sections.py      # Section CRUD, content blocks, verify
│   │   ├── cards.py         # List (paginated), patch, reject, regenerate, bulk ops
│   │   ├── generate.py      # Estimate cost, start generation, poll job, active jobs
│   │   ├── curriculum.py    # Curriculum tree CRUD + coverage stats
│   │   ├── rules.py         # Rule set CRUD + set-default
│   │   ├── export.py        # CSV export
│   │   └── usage.py         # AI usage cost summary
│   └── services/
│       ├── doc_processor.py          # Parse .docx/.html, split by H2, build heading tree
│       ├── image_classifier.py       # Claude Vision: classify images, extract text
│       ├── table_converter.py        # Word tables → plain text blocks
│       ├── duplicate_detector.py     # Semantic duplicate detection via Claude
│       ├── merge_engine.py           # Merge new content into existing sections
│       ├── generator.py              # ANCHOR_INSTRUCTION, card generation per section
│       ├── supplemental_generator.py # Vignette + teaching case generation
│       └── cost_estimator.py         # Token estimation + cost calculation
├── frontend/src/
│   ├── App.tsx               # Router + nav bar + cost display
│   ├── main.tsx              # React entry point
│   ├── context/
│   │   └── SettingsContext.tsx  # Model + rule set selections, persisted to localStorage
│   ├── pages/
│   │   ├── WorkspacePage.tsx   # Sidebar (documents/topics) + card panel + upload
│   │   ├── CardsPanel.tsx      # TanStack table, server-side pagination, generation controls
│   │   ├── LibraryPage.tsx     # Topics tree + documents list + rules CRUD
│   │   └── SectionViewer.tsx   # Full-screen section content viewer with image gallery
│   ├── components/             # Shared: AnkifyModal, AlertModal, ConfirmModal, CostFlash,
│   │                           #         HelpChat, SettingsPopover, CurriculumPicker, UsageModal
│   ├── api.ts                  # Axios wrappers for all API endpoints
│   ├── types.ts                # TypeScript interfaces
│   ├── utils.ts                # flattenTree, subtreeIds, buildAggregatedCounts
│   └── version.ts              # APP_VERSION
├── data/
│   ├── curriculum.json         # Emergency Medicine + Surgery curriculum (loaded on first boot)
│   ├── uploads/                # Uploaded .docx files (auto-deleted after processing)
│   └── app.db                  # SQLite database (created on first boot)
├── seed/
│   ├── curriculum.json         # Curriculum seed (copied to data/ by entrypoint)
│   └── ai-rules.md            # Default card generation rules
├── .env                        # ANTHROPIC_API_KEY
├── requirements.txt
├── Dockerfile
└── entrypoint.sh
```

## Database Schema

### Core Entities
- **curriculum**: id, parent_id (self-FK), name, level, path, sort_order — OLD curriculum tree from curriculum.json
- **rule_sets**: id, name, rule_type (generation/vignette/teaching_case), content, is_default, created_at
- **topic_trees**: id, name, slug, curriculum_id (FK, nullable), created_at — one per H1 main topic
- **sections**: id, topic_tree_id (FK), heading, slug, heading_tree (JSON), content_text, content_html, curriculum_topic_id (FK, nullable), curriculum_topic_path, image_count, table_count, flags (JSON), is_verified, sort_order
- **content_blocks**: id, section_id (FK), upload_id (FK), text, html, block_type, heading_context, position, is_duplicate, duplicate_of_id (self-FK)
- **uploads**: id, topic_tree_id (FK), original_name, filename, status (processing/ready/error/merged), processing_log, uploaded_at
- **section_images**: id, section_id (FK), upload_id (FK), data_uri, category (decorative/diagram/chart/table_image/unclear), extracted_text, alt_text_hint, position

### Card & Generation
- **cards**: id, section_id (FK), card_number, front_html, front_text, tags (JSON), extra, vignette, teaching_case, source_ref, ref_img_id (FK to section_images), ref_img_position, note_id (BigInt), status (active/rejected), needs_review, is_reviewed, created_at, updated_at
- **generation_jobs**: id, section_id (FK, nullable), topic_tree_id (FK, nullable), job_type, scope, model, rule_set_id (FK), status (pending/running/done/failed), total_sections, processed_sections, total_cards, estimated_cost_usd, actual_input/output_tokens, pipeline_step, error_message, started_at, finished_at
- **processing_jobs**: id, upload_id (FK), status, pipeline_step (parsing/images/tables/comparing/merging/done), error_message, started_at, finished_at
- **ai_usage_log**: id, operation, model, input_tokens, output_tokens, cost_usd, topic_tree_id, section_id, card_id, job_id, created_at

## Key Workflows

### Document Upload & Processing
1. Reviewer prepares .docx in Word: applies Heading 1-4 styles, adds alt text on images (`EXTRACT`/`REFERENCE`)
2. Upload → picks target topic tree (new or existing)
3. Background processing: parse headings → split by H2 → create sections + content blocks
4. Image processing: Claude Vision classifies images, extracts text from EXTRACT-marked ones
5. Table conversion: native Word tables → plain text blocks
6. If merging into existing topic tree: semantic duplicate detection → merge new content at correct position
7. Result: master topic tree updated, sections ready for generation

### Card Generation
1. User picks section (H2) or subsection (H3/H4) in sidebar
2. Clicks "Generate" → AI receives section text + full heading tree + curriculum path + rules
3. Produces: cloze cards + extra field + source refs (one call per section, parallel with 3 workers)
4. Supplementals (vignettes + teaching cases) generated per condition group
5. Generation runs in background — survives page close, resumes polling on refresh

### Background Job Resilience
- `GET /api/generate/jobs/active` returns running/pending jobs
- Frontend checks on mount, resumes polling for all active jobs
- Animated badge on topic trees with active generation in sidebar
- Safe delete: active jobs failed + nullified before CASCADE delete

## Key Conventions
- FastAPI routes have NO trailing slash
- Card output format: `number|card text|extra (optional)|source:P1-P3` (pipe-delimited)
- `ANCHOR_INSTRUCTION` in `generator.py` — hardcoded system prompt for card generation rules
- All AI calls use `temperature=0`
- System prompts use `cache_control: {"type": "ephemeral"}` for Anthropic prompt caching
- Background tasks use `SessionLocal()` (not the request session)
- Card generation: 3 concurrent workers with exponential backoff retry (20/40/80s, 4 attempts max)
- Server-side pagination: cards fetched with `limit`/`offset`, TanStack Table uses `manualPagination`
- Cloze format: `{{c1::term}}` — always c1, regardless of card number
- `**markdown bold**` is FORBIDDEN in card output — use `<b>HTML bold</b>` only
- Topic path format: `Parent > Child > Leaf` with ` > ` separators

## Adding Models
Edit `backend/config.py` — the `MODELS` dict is the single source of truth:
```python
"claude-opus-4-6": {
    "display": "Claude Opus 4.6",
    "input_per_1m": 5.0,
    "output_per_1m": 25.0,
},
```
Only Anthropic models work — the SDK is `anthropic.Anthropic` only.

## Admin Endpoints
- `GET /api/admin/disk-usage` — shows size of each data subdirectory
- `POST /api/admin/clear-storage` — clears `uploads/` to free disk space
- Browser console: `fetch('/api/admin/clear-storage', {method: 'POST'}).then(r => r.json()).then(console.log)`

## Environment
- `.env` at `/v4/.env` — requires `ANTHROPIC_API_KEY`
- SQLite DB at `./data/app.db` (created on first boot)
- Uploads stored in `./data/uploads/` (auto-deleted after processing)
- DB can be deleted and will be recreated on next start (seed data re-runs)

## Differences from v3
| | v3 | v4 |
|---|---|---|
| Data model | Document → Chunk → Card | TopicTree → Section → ContentBlock → Card |
| Chunking | AI-powered or heading-based | Deterministic by H2 heading styles |
| Topic detection | Separate AI step | Matched against curriculum during processing |
| Multiple uploads | Each upload independent | Subsequent uploads merge into master topic tree |
| Duplicate detection | None | Semantic via Claude |
| Image handling | Stored as base64 on every card (37x bloat) | Stored once in section_images, cards reference by ID |
| Pagination | Client-side (loaded all cards) | Server-side (limit/offset from API) |
| Card generation context | One chunk's text | Section text + full heading tree + curriculum path |

## Notes for AI Assistants
- The client is a PA exam prep provider. Medical accuracy in card content matters.
- The OLD curriculum (curriculum.json) is the working reference. New curriculum mapping planned for post-June 2026.
- `doc_processor.py` handles both .docx (python-docx) and HTML (BeautifulSoup) parsing
- Image alt text hints: `EXTRACT` = extract knowledge, `REFERENCE` = keep as decorative, empty = AI classifies
- The merge engine uses Claude for both duplicate detection and insertion positioning
- Content blocks track provenance (which upload contributed each paragraph)
- `section.heading_tree` is a JSON field with nested H3/H4 structure for the heading tree context sent to the AI during generation
- Supplemental generation (vignettes/teaching cases) groups cards by leaf topic and generates per condition
- The frontend SectionViewer shows processed content with flags, image gallery, and verify button
