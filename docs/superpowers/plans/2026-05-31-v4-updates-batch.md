# V4 Updates Batch Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix tag generation bug, add ref image gallery UI, section edit with paste, fix paste feature, add section status colors, add create-leaf-node shortcut, escape-to-close modal, and normalize curriculum matching.

**Architecture:** Eight independent tasks touching backend models/routers and frontend components. No test infrastructure exists — verify manually via dev server. Tasks are ordered by dependency: schema changes first, then backend endpoints, then frontend.

**Tech Stack:** FastAPI + SQLAlchemy (backend), React 19 + TypeScript + Tailwind v4 (frontend), SQLite.

---

## File Map

| File | Changes |
|------|---------|
| `backend/models.py` | Add `section_status` column to Section |
| `backend/routers/generate.py` | Fix tag field selection based on curriculum version |
| `backend/routers/documents.py` | Normalize curriculum matching; auto-detect orange sections |
| `backend/routers/sections.py` | Add `section_status` to SectionUpdate; add `POST /{id}/paste` endpoint; add `POST /{id}/images` endpoint |
| `frontend/src/types.ts` | Add `section_status` to Section/SectionDetail interfaces |
| `frontend/src/api.ts` | Add `updateSection` params for `section_status`; add `pasteSectionContent()` and `uploadSectionImage()` functions |
| `frontend/src/pages/SectionViewer.tsx` | Add escape handler, status toggle, edit/paste mode, create-leaf-node button, ref image gallery |
| `frontend/src/pages/CardsPanel.tsx` | Replace read-only ref_img cell with clickable image picker popover |
| `frontend/src/pages/WorkspacePage.tsx` | Update status dot colors for section_status; fix paste refresh; change eye icon to dropdown |

---

### Task 1: Fix Tag Generation Bug

**Files:**
- Modify: `backend/routers/generate.py:280-360`

The bug: tags are always saved to `card.tags` (line 359). The frontend shows `card.tags` under "Current" (activeTagSet='old') and `card.tags_mapped` under "New" (activeTagSet='new'). When a section is mapped to a v1 ("New") curriculum node, its tags should go into `tags_mapped` instead.

- [ ] **Step 1: Add curriculum version lookup in `_run_generation`**

In `generate.py`, after the section pre-load block (lines 282-293), also load each section's curriculum node version. Modify the section data dict to include the curriculum version:

```python
# Inside the for loop at line 283-293, after building sections_by_id:
for section_id, sdata in sections_by_id.items():
    section = db.get(Section, section_id)
    if section and section.curriculum_topic_id:
        cur_node = db.get(Curriculum, section.curriculum_topic_id)
        sdata["curriculum_version"] = cur_node.version if cur_node else None
    else:
        sdata["curriculum_version"] = None
```

Add `Curriculum` to the imports at the top of the file (it's in `backend.models`).

- [ ] **Step 2: Route tags to correct field based on version**

Replace the tag assignment logic at lines 347-363. Change from always setting `tags=tags` to checking the version:

```python
# Line 347 — after getting section_data from future result
tags = section_data["curriculum_topic_path"].split(" > ") if section_data.get("curriculum_topic_path") else []
cv = section_data.get("curriculum_version")

if card_version == "base":
    for card_data in cards_data:
        card_kwargs = dict(
            section_id=section_data["id"],
            card_number=card_data["card_number"],
            front_html=card_data["front_html"],
            front_text=card_data["front_text"],
            extra=card_data.get("extra"),
            source_ref=card_data.get("source_ref"),
            needs_review=needs_review,
            note_id=next_note_id(),
        )
        # Route tags to the correct field based on curriculum version
        if cv == "v1":
            card_kwargs["tags_mapped"] = tags
            card_kwargs["tags"] = []
        else:
            card_kwargs["tags"] = tags
        card = Card(**card_kwargs)
        db.add(card)
    total_cards += len(cards_data)
```

- [ ] **Step 3: Verify manually**

Start backend: `PYTHONPATH=. .venv/bin/uvicorn backend.main:app --reload`
- Generate cards for a section mapped to v1 curriculum → check that `tags_mapped` is populated and `tags` is empty
- Generate cards for a section mapped to v2 curriculum → check that `tags` is populated as before

- [ ] **Step 4: Commit**

```bash
git add backend/routers/generate.py
git commit -m "fix: route card tags to correct field based on curriculum version"
```

---

### Task 2: Normalize Curriculum Matching

**Files:**
- Modify: `backend/routers/documents.py:19-55`

Fix: "Breast Augmentation / Reduction" should match "Breast augmentation/reduction". Normalize both strings before comparing.

- [ ] **Step 1: Add normalization helper and update matching query**

Add a `_normalize_for_match` helper above `_match_section_to_curriculum`:

```python
import re

def _normalize_for_match(s: str) -> str:
    """Normalize string for fuzzy curriculum matching.
    Lowercases, collapses whitespace around '/', strips extra spaces.
    """
    s = s.lower().strip()
    s = re.sub(r'\s*/\s*', '/', s)  # "a / b" -> "a/b"
    s = re.sub(r'\s+', ' ', s)       # collapse multiple spaces
    return s
```

- [ ] **Step 2: Update `_match_section_to_curriculum` to use normalized comparison**

Replace the exact `func.lower()` query (lines 40-48) with a Python-side normalized comparison since SQLite can't do regex normalization:

```python
def _match_section_to_curriculum(
    db: Session,
    heading: str,
    parent_curriculum_id: Optional[int],
) -> tuple[Optional[int], Optional[str]]:
    if not parent_curriculum_id:
        return None, None

    parent = db.get(Curriculum, parent_curriculum_id)
    if not parent:
        return None, None

    norm_heading = _normalize_for_match(heading)

    # Get all nodes in the subtree and compare normalized
    candidates = (
        db.query(Curriculum)
        .filter(
            Curriculum.version == parent.version,
            Curriculum.path.startswith(parent.path),
        )
        .all()
    )

    for node in candidates:
        if _normalize_for_match(node.name) == norm_heading:
            return node.id, node.path

    # Fallback: use the parent node itself
    return parent.id, parent.path
```

- [ ] **Step 3: Verify manually**

Upload a document with heading "Breast Augmentation / Reduction" when curriculum has "Breast augmentation/reduction" → should match correctly.

- [ ] **Step 4: Commit**

```bash
git add backend/routers/documents.py
git commit -m "fix: normalize curriculum matching to handle case and spacing differences"
```

---

### Task 3: Add Section Status Field (Orange/Green/Normal)

**Files:**
- Modify: `backend/models.py:67-84`
- Modify: `backend/routers/sections.py:11-18,112-133`
- Modify: `backend/routers/documents.py:460-505`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts:159-165`
- Modify: `frontend/src/pages/SectionViewer.tsx`
- Modify: `frontend/src/pages/WorkspacePage.tsx`

- [ ] **Step 1: Add `section_status` to Section model**

In `backend/models.py`, add after line 82 (`sort_order`):

```python
section_status: Mapped[str] = mapped_column(String(20), default="normal")  # normal, green, orange
```

- [ ] **Step 2: Run migration**

SQLite doesn't have ALTER COLUMN, but SQLAlchemy with `create_all` will handle new columns. Just restart the server. If the column doesn't appear, run:

```python
# In a Python shell or add to main.py startup temporarily:
from sqlalchemy import text
from backend.db import engine
with engine.connect() as conn:
    conn.execute(text("ALTER TABLE sections ADD COLUMN section_status VARCHAR(20) DEFAULT 'normal'"))
    conn.commit()
```

- [ ] **Step 3: Add `section_status` to SectionUpdate model and PATCH handler**

In `backend/routers/sections.py`, update the `SectionUpdate` model (lines 11-18):

```python
class SectionUpdate(BaseModel):
    heading: Optional[str] = None
    content_text: Optional[str] = None
    content_html: Optional[str] = None
    curriculum_topic_id: Optional[int] = None
    curriculum_topic_path: Optional[str] = None
    is_verified: Optional[bool] = None
    flags: Optional[list] = None
    section_status: Optional[str] = None  # ADD THIS
```

In the PATCH handler (lines 112-133), add:

```python
if body.section_status is not None:
    section.section_status = body.section_status
```

- [ ] **Step 4: Include `section_status` in section_to_dict responses**

In `backend/routers/sections.py`, in `section_to_dict()` (around line 21-63), and in `backend/routers/documents.py` `section_to_dict()` (around line 74-95), add `section_status` to the returned dict:

```python
"section_status": s.section_status,
```

- [ ] **Step 5: Auto-detect orange during document processing**

In `backend/routers/documents.py`, in the section creation block (around line 491-504), after building `content_text`, add:

```python
auto_status = "orange" if "NO INFORMATION IN ORIGINAL STUDY GUIDE" in content_text.upper() else "normal"
```

Use `auto_status` when creating the Section:

```python
section = Section(
    # ... existing fields ...
    section_status=auto_status,
)
```

Also add auto-detection in the merge path (around line 477-489):

```python
if "NO INFORMATION IN ORIGINAL STUDY GUIDE" in content_text.upper():
    section.section_status = "orange"
```

- [ ] **Step 6: Update frontend types**

In `frontend/src/types.ts`, add to the `Section` interface:

```typescript
section_status: 'normal' | 'green' | 'orange';
```

- [ ] **Step 7: Update frontend api.ts**

In `frontend/src/api.ts`, update `updateSection` params type (line 161):

```typescript
export async function updateSection(
  id: number,
  params: { heading?: string; curriculum_topic_id?: number | null; curriculum_topic_path?: string | null; is_verified?: boolean; section_status?: string }
): Promise<Section> {
```

- [ ] **Step 8: Add status toggle in SectionViewer.tsx**

In the SectionViewer header area (after the verify button), add a clickable status badge:

```typescript
{/* Status toggle */}
<button
  onClick={() => {
    if (!section) return;
    const next = section.section_status === 'normal' ? 'green' : section.section_status === 'green' ? 'orange' : 'normal';
    updateSection(sectionId, { section_status: next }).then(() => loadSection());
  }}
  className={`px-2 py-0.5 rounded text-[10px] font-medium ${
    section?.section_status === 'green' ? 'bg-green-100 text-green-700' :
    section?.section_status === 'orange' ? 'bg-orange-100 text-orange-700' :
    'bg-gray-100 text-gray-500'
  }`}
  title="Click to cycle status: Normal → Keep (green) → No Info (orange)"
>
  {section?.section_status === 'green' ? 'Keep' : section?.section_status === 'orange' ? 'No Info' : 'Normal'}
</button>
```

- [ ] **Step 9: Update sidebar section colors in WorkspacePage.tsx**

In both the Documents tab (lines 877-885) and the Curriculum Action Bar (lines 180-181), update the status dot and text color logic:

For the status dot (replace existing logic):

```typescript
<span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
  section.section_status === 'green' ? 'bg-green-400' :
  section.section_status === 'orange' ? 'bg-orange-400' :
  section.is_verified ? 'bg-green-400' :
  (section.flags?.length ?? 0) > 0 ? 'bg-amber-400' :
  'bg-gray-300'
}`} />
```

For the section heading text, add conditional color:

```typescript
<span className={`text-xs truncate block ${
  section.section_status === 'green' ? 'text-green-600' :
  section.section_status === 'orange' ? 'text-orange-500' :
  ''
}`}>{section.heading}</span>
```

- [ ] **Step 10: Commit**

```bash
git add backend/models.py backend/routers/sections.py backend/routers/documents.py frontend/src/types.ts frontend/src/api.ts frontend/src/pages/SectionViewer.tsx frontend/src/pages/WorkspacePage.tsx
git commit -m "feat: add section status colors (normal/green/orange) with auto-detect and manual toggle"
```

---

### Task 4: Fix Paste Feature

**Files:**
- Modify: `frontend/src/pages/WorkspacePage.tsx`

The paste flow calls `pasteDocument()` which returns `{ upload_id, processing_job_id, topic_tree_id }`. The polling mechanism (lines 560-585) calls `loadTopicTrees()` on success. The issue is likely that either the `processing_job_id` isn't being set correctly, or the newly created topic tree isn't showing up because of a race condition or missing state update.

- [ ] **Step 1: Debug paste flow**

Add console.log statements to trace the paste flow. Check:
1. Does `handlePasteSubmit` receive a valid `processing_job_id`?
2. Does the polling loop run and reach `status === 'done'`?
3. Does `loadTopicTrees()` fire and update the tree list?
4. Is the new topic tree in the response from `getTopicTrees()`?

Run the backend and frontend dev servers, open browser console, paste content, and observe.

- [ ] **Step 2: Check if the paste response includes topic_tree_id**

Looking at the code, `handlePasteSubmit` (line 675-691) stores `processing_job_id` but does NOT use the returned `topic_tree_id`. After paste completes and `loadTopicTrees()` runs, the new tree should appear. But if the tree was created with a duplicate slug, the backend would throw 409.

Check the paste backend endpoint: it creates a TopicTree but doesn't check for slug conflicts like the upload endpoint does (paste line 193-199 vs upload line 126-132). The paste endpoint doesn't have the duplicate slug check, which means it could silently create duplicates or fail.

- [ ] **Step 3: Ensure paste modal passes the `topic_tree_name` correctly**

Check that the paste modal sends `name` field (not just `topic_tree_name`). The backend accepts both (line 175): `body.get("topic_tree_name") or body.get("name")`. The frontend sends `name` (from api.ts line 128, the field isn't explicitly named — check the pasteDocument function).

Looking at `api.ts:119-134`: the frontend sends `{ html, name, topic_tree_id, curriculum_id }` but the backend expects `topic_tree_name` or `name`. The backend line 175 handles both: `body.get("topic_tree_name") or body.get("name")`. This should work.

- [ ] **Step 4: Fix potential issue — paste into existing topic tree**

When `topic_tree_id` is provided (paste into existing tree), the new sections merge. But when creating a new tree, the slug may conflict. Add slug uniqueness handling to the paste endpoint like the upload endpoint has:

In `backend/routers/documents.py`, paste endpoint (around line 192-199), add slug deduplication:

```python
if not topic_tree_id:
    slug = slugify(topic_tree_name)
    existing = db.query(TopicTree).filter_by(slug=slug).first()
    if existing:
        # Auto-increment slug to avoid conflicts
        slug = f"{slug}-{uuid.uuid4().hex[:6]}"
    tt = TopicTree(
        name=topic_tree_name,
        slug=slug,
        curriculum_id=curriculum_id,
    )
    db.add(tt)
    db.flush()
```

- [ ] **Step 5: Ensure paste response includes topic_tree_id in frontend state**

After paste completes successfully, auto-expand the new topic tree. In the polling success path (around line 572-575), after `loadTopicTrees()`:

Store the topic_tree_id from the paste response and use it to auto-expand after processing completes. In `handlePasteSubmit`, store the returned `topic_tree_id`:

```typescript
// In handlePasteSubmit, after the pasteDocument call:
const result = await pasteDocument(pastedHtml, pasteName, opts);
setProcessingJobId(result.processing_job_id);
setPasteTargetTreeId(result.topic_tree_id);  // NEW state variable
```

Then in the polling success path:

```typescript
if (job.status === 'done') {
    loadTopicTrees();
    const treeToExpand = pasteTargetTreeId ?? expandedTreeId;
    if (treeToExpand) expandTree(treeToExpand);
    setPasteTargetTreeId(null);
}
```

Add state: `const [pasteTargetTreeId, setPasteTargetTreeId] = useState<number | null>(null);`

- [ ] **Step 6: Commit**

```bash
git add backend/routers/documents.py frontend/src/pages/WorkspacePage.tsx
git commit -m "fix: paste feature — handle slug conflicts and auto-expand new topic tree"
```

---

### Task 5: Section Edit with Paste in SectionViewer

**Files:**
- Modify: `backend/routers/sections.py` — add `POST /{id}/paste` endpoint
- Modify: `frontend/src/api.ts` — add `pasteSectionContent()` function
- Modify: `frontend/src/pages/SectionViewer.tsx` — add edit/paste mode

- [ ] **Step 1: Add `POST /sections/{id}/paste` backend endpoint**

In `backend/routers/sections.py`, add a new endpoint that accepts HTML, parses it, and replaces the section's content:

```python
from backend.services.doc_processor import parse_html, split_by_h2, build_heading_tree, build_content_html
import os, uuid

@router.post("/{section_id}/paste")
def paste_section_content(section_id: int, body: dict, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Replace section content with pasted HTML. Processes images too."""
    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404)

    html = body.get("html", "")
    if not html.strip():
        raise HTTPException(400, "No HTML content provided")

    # Parse the HTML to extract elements
    from backend.services.doc_processor import parse_html_string
    elements = parse_html_string(html)

    # Build content from elements
    content_text = "\n".join(e["text"] for e in elements if e.get("text"))
    content_html_str = build_content_html(elements)

    # Update section content
    section.content_text = content_text
    section.content_html = content_html_str

    # Auto-detect orange status
    if "NO INFORMATION IN ORIGINAL STUDY GUIDE" in content_text.upper():
        section.section_status = "orange"
    elif section.section_status == "orange":
        # Clear orange if content was replaced with real content
        section.section_status = "normal"

    # Handle images from pasted content
    image_count = 0
    for elem in elements:
        if elem.get("type") == "image" and elem.get("data_uri"):
            img = SectionImage(
                section_id=section.id,
                data_uri=elem["data_uri"],
                alt_text_hint=elem.get("alt_text"),
                position=image_count,
            )
            db.add(img)
            image_count += 1

    section.image_count = (section.image_count or 0) + image_count
    section.updated_at = utcnow()
    db.commit()
    db.refresh(section)
    return section_to_dict(section, include_content=True)
```

Note: Need to add `BackgroundTasks` to imports and add `SectionImage` and `utcnow` to imports. Also need to check if `parse_html_string` exists or if we need to use `parse_html` (which takes a file path). If `parse_html_string` doesn't exist, create a thin wrapper or write HTML to a temp file.

Check `doc_processor.py` for available functions — likely need `parse_html(filepath)` which reads from a file, so write the HTML to a temp file first:

```python
import tempfile

# Write HTML to temp file for parsing
with tempfile.NamedTemporaryFile(mode='w', suffix='.html', delete=False, encoding='utf-8') as tmp:
    tmp.write(html)
    tmp_path = tmp.name

try:
    elements = parse_html(tmp_path)
finally:
    os.unlink(tmp_path)
```

- [ ] **Step 2: Add `pasteSectionContent` to frontend api.ts**

```typescript
export async function pasteSectionContent(
  sectionId: number,
  html: string
): Promise<SectionDetail> {
  const res = await http.post<SectionDetail>(`/sections/${sectionId}/paste`, { html });
  return res.data;
}
```

- [ ] **Step 3: Add edit/paste mode to SectionViewer.tsx**

Add state for edit mode:

```typescript
const [editMode, setEditMode] = useState(false);
const [pasteHtml, setPasteHtml] = useState('');
const pasteAreaRef = useRef<HTMLDivElement>(null);
```

Add an "Edit Section" button next to the Verify button in the header. When clicked, show a paste area below the header (same clipboard capture as the main paste modal):

```typescript
{/* Edit Section button */}
<button
  onClick={() => { setEditMode(!editMode); setTimeout(() => pasteAreaRef.current?.focus(), 100); }}
  className="px-3 py-1 rounded text-xs font-medium bg-blue-50 text-blue-600 hover:bg-blue-100"
>
  {editMode ? 'Cancel Edit' : 'Edit Section'}
</button>
```

When `editMode` is true, show a paste area:

```typescript
{editMode && (
  <div className="border-b border-gray-200 p-4 bg-blue-50/50">
    <p className="text-xs text-gray-500 mb-2">Paste content from your document below:</p>
    <div
      ref={pasteAreaRef}
      contentEditable
      tabIndex={0}
      onPaste={(e) => {
        e.preventDefault();
        const html = e.clipboardData.getData('text/html') || e.clipboardData.getData('text/plain');
        setPasteHtml(html);
      }}
      className="min-h-[60px] border border-dashed border-blue-300 rounded p-3 bg-white text-xs text-gray-600 focus:outline-none focus:border-blue-500"
    >
      {pasteHtml ? '✓ Content captured. Click "Apply" to replace section content.' : 'Click here and paste (Ctrl+V / Cmd+V)'}
    </div>
    {pasteHtml && (
      <div className="mt-2 flex gap-2">
        <button
          onClick={async () => {
            await pasteSectionContent(sectionId, pasteHtml);
            setPasteHtml('');
            setEditMode(false);
            loadSection();
          }}
          className="px-3 py-1 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700"
        >
          Apply
        </button>
        <button onClick={() => setPasteHtml('')} className="px-3 py-1 rounded text-xs font-medium bg-gray-100 text-gray-600">
          Clear
        </button>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 4: Commit**

```bash
git add backend/routers/sections.py frontend/src/api.ts frontend/src/pages/SectionViewer.tsx
git commit -m "feat: section edit with paste — replace section content from clipboard"
```

---

### Task 6: Ref Image Gallery UI for Cards

**Files:**
- Modify: `backend/routers/sections.py` — add `POST /{id}/images` for upload
- Modify: `frontend/src/api.ts` — add `uploadSectionImage()` and `getSectionImages()` functions
- Modify: `frontend/src/pages/CardsPanel.tsx` — replace read-only ref_img cell with image picker

- [ ] **Step 1: Add image upload endpoint**

In `backend/routers/sections.py`:

```python
@router.post("/{section_id}/images")
async def upload_section_image(
    section_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Upload an image directly to a section's image library."""
    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404)

    import base64
    content = await file.read()
    mime = file.content_type or "image/png"
    data_uri = f"data:{mime};base64,{base64.b64encode(content).decode()}"

    max_pos = db.query(func.max(SectionImage.position)).filter_by(section_id=section_id).scalar() or 0
    img = SectionImage(
        section_id=section_id,
        data_uri=data_uri,
        alt_text_hint=file.filename,
        position=max_pos + 1,
        category="unclear",
    )
    db.add(img)
    section.image_count = (section.image_count or 0) + 1
    db.commit()
    db.refresh(img)

    return {
        "id": img.id,
        "section_id": img.section_id,
        "data_uri": img.data_uri,
        "category": img.category,
        "extracted_text": img.extracted_text,
        "alt_text_hint": img.alt_text_hint,
        "position": img.position,
    }
```

Add `UploadFile, File` and `func` to the imports.

- [ ] **Step 2: Add frontend API functions**

In `frontend/src/api.ts`:

```typescript
export async function uploadSectionImage(sectionId: number, file: File): Promise<SectionImage> {
  const form = new FormData();
  form.append('file', file);
  const res = await http.post<SectionImage>(`/sections/${sectionId}/images`, form);
  return res.data;
}
```

- [ ] **Step 3: Build ImagePickerPopover component in CardsPanel.tsx**

Add a popover component inside CardsPanel.tsx (or as a local component) that:
- Receives `sectionId`, `currentRefImgId`, `currentRefImgPosition`
- Fetches section images via `getSection(sectionId)` to get `images[]`
- Renders a grid of thumbnails
- Each thumbnail has: "Front"/"Back" toggle, "Attach" button
- Currently attached image shows "Detach" button
- Bottom: file input for "Upload new image"
- On attach: calls `updateCard(cardId, { ref_img_id: imgId, ref_img_position: position })`
- On detach: calls `updateCard(cardId, { ref_img_id: 0 })`  (0 clears it per existing backend logic)
- On upload: calls `uploadSectionImage(sectionId, file)` then attaches

- [ ] **Step 4: Replace ref_img column cell in CardsPanel.tsx**

Replace the current read-only cell (lines 914-925) with a clickable cell that opens the ImagePickerPopover:

```typescript
columnHelper.accessor('ref_img', {
  header: 'Ref Image',
  size: 100,
  cell: (info) => {
    const card = info.row.original;
    const val = info.getValue();
    return (
      <ImagePickerCell
        cardId={card.id}
        sectionId={card.section_id}
        currentImg={val}
        currentImgId={card.ref_img_id}
        currentPosition={card.ref_img_position}
        onUpdate={() => fetchCards(sectionId, topicPath)}
      />
    );
  },
}),
```

The `ImagePickerCell` component:
- Shows current image thumbnail (or "+" icon if none)
- On click: opens a popover/dropdown with the section's image gallery
- Gallery shows all section images as thumbnails
- Each image has "Front"/"Back" radio + "Select" button
- "Detach" button if an image is already assigned
- "Upload" button with hidden file input
- Popover closes on outside click

- [ ] **Step 5: Commit**

```bash
git add backend/routers/sections.py frontend/src/api.ts frontend/src/pages/CardsPanel.tsx
git commit -m "feat: ref image gallery — pick, attach, detach, and upload section images for cards"
```

---

### Task 7: Create Leaf Node from Section Modal

**Files:**
- Modify: `frontend/src/api.ts` — ensure `createCurriculumNode` is available (check if it exists)
- Modify: `frontend/src/pages/SectionViewer.tsx` — add create leaf node UI

- [ ] **Step 1: Check that createCurriculumNode exists in api.ts**

It should already exist (used in LibraryPage). Verify it accepts `{ name, parent_id, version? }` and returns the created node with `id` and `path`.

- [ ] **Step 2: Add "Create & Map to Leaf" UI in SectionViewer**

For sections without a `curriculum_topic_id` (or with the "No leaf" warning), add a button:

```typescript
{!section.curriculum_topic_id && (
  <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded">
    <p className="text-xs text-amber-700 mb-2">This section has no curriculum leaf match.</p>
    <button
      onClick={() => setShowCreateLeaf(true)}
      className="px-3 py-1 rounded text-xs font-medium bg-amber-100 text-amber-700 hover:bg-amber-200"
    >
      Create & Map to New Leaf
    </button>
  </div>
)}
```

When `showCreateLeaf` is true, show an inline form:
- CurriculumPicker to select parent node
- Text input for leaf name (pre-filled with `section.heading`)
- "Create" button that:
  1. Calls `createCurriculumNode({ name: leafName, parent_id: selectedParentId })`
  2. Gets back the new node's `id` and `path`
  3. Calls `updateSection(sectionId, { curriculum_topic_id: newNode.id, curriculum_topic_path: newNode.path })`
  4. Reloads section

State variables:

```typescript
const [showCreateLeaf, setShowCreateLeaf] = useState(false);
const [leafName, setLeafName] = useState('');
const [leafParentId, setLeafParentId] = useState<number | null>(null);
```

Initialize `leafName` from `section.heading` when section loads.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/SectionViewer.tsx
git commit -m "feat: create curriculum leaf node directly from section viewer modal"
```

---

### Task 8: Eye Icon Dropdown (View vs Load Cards)

**Files:**
- Modify: `frontend/src/pages/WorkspacePage.tsx`

Change the eye icon from a direct onClick to a small dropdown with "View Section" and "Load Cards" options.

- [ ] **Step 1: Create EyeDropdown component**

Inside WorkspacePage.tsx (or above the main component), create a small dropdown:

```typescript
function EyeDropdown({ onView, onLoadCards }: { onView: () => void; onLoadCards: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="p-0.5 text-gray-300 hover:text-blue-500 transition-colors duration-150"
        title="Section actions"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded shadow-lg z-50 py-1 min-w-[120px]">
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); onView(); }}
            className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
          >
            View Section
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); onLoadCards(); }}
            className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
          >
            Load Cards
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Replace eye icon buttons**

In the Documents tab (lines 897-909), replace the eye button with:

```typescript
<EyeDropdown
  onView={() => setViewingSectionId(section.id)}
  onLoadCards={() => selectSection(section)}
/>
```

In the Curriculum Action Bar (lines 193-202), replace similarly:

```typescript
<EyeDropdown
  onView={() => onViewSection(section.id)}
  onLoadCards={() => onSelectSection(section)}
/>
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/WorkspacePage.tsx
git commit -m "feat: eye icon dropdown with View Section and Load Cards options"
```

---

### Task 9: Escape to Close Section Modal

**Files:**
- Modify: `frontend/src/pages/SectionViewer.tsx`

- [ ] **Step 1: Add keyboard event handler**

Add a `useEffect` for the Escape key:

```typescript
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}, [onClose]);
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/SectionViewer.tsx
git commit -m "feat: close section viewer modal on Escape key"
```

---

## Execution Order

Tasks are independent and can be parallelized, but recommended order for manual execution:

1. **Task 1** (Tag bug) — quick backend fix
2. **Task 2** (Matching normalization) — quick backend fix
3. **Task 9** (Escape to close) — trivial
4. **Task 3** (Section status) — schema change, needed by Task 5
5. **Task 4** (Fix paste) — debug and fix
6. **Task 5** (Section edit with paste) — depends on Task 3 for auto-status
7. **Task 7** (Create leaf node) — independent frontend
8. **Task 8** (Eye icon dropdown) — independent frontend
9. **Task 6** (Ref image gallery) — largest task, do last
