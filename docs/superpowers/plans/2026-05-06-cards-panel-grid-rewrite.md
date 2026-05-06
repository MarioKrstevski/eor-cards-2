# CardsPanel Grid Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the v4 CardsPanel table view to match v3's Excel-like grid with cell selection, arrow key navigation, double-click inline editing, global search, Anki/Text toggle, and an enhanced selection action bar.

**Architecture:** The table view gets an `EditableCell` sub-component using DOM refs (not React state) for cell selection to avoid re-renders. Arrow keys navigate between editable cells. The existing generation flow, card grid view, pagination, and modals are preserved unchanged. A `TagsCell` handles inline tag editing with pill UI.

**Tech Stack:** React 19, TanStack Table v8, TypeScript, Tailwind CSS v4, DOM refs for selection

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `frontend/src/pages/CardsPanel.tsx` | Rewrite | Main component — add EditableCell, TagsCell, cell selection, keyboard nav, search, Anki toggle |
| `frontend/src/index.css` | Modify | Add EditableCell focus/selection styles |

All changes are in a single file (CardsPanel.tsx) plus minor CSS. This follows v3's pattern where EditableCell, TagsCell, and CardTile are all defined in the same file.

---

### Task 1: Add EditableCell Component

**Files:**
- Modify: `frontend/src/pages/CardsPanel.tsx` (add before CardTile, ~line 54)

- [ ] **Step 1: Add EditableCell component**

```tsx
interface EditableCellProps {
  value: string;
  cellId: string;            // "rowIndex:colId"
  onSave: (val: string) => void;
  onSelect: (cellId: string) => void;
  onNavigate: (dir: 'up' | 'down' | 'left' | 'right') => void;
  multiline?: boolean;
  clampLines?: number;
  renderDisplay?: (val: string) => React.ReactNode;
}

function EditableCell({ value, cellId, onSave, onSelect, onNavigate, multiline, clampLines, renderDisplay }: EditableCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [localVal, setLocalVal] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setLocalVal(value); }, [value]);

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  useEffect(() => {
    if (isEditing && textareaRef.current) autoResize(textareaRef.current);
  }, [isEditing, localVal]);

  function startEdit() { setLocalVal(value); setIsEditing(true); }
  function save() { setIsEditing(false); if (localVal !== value) onSave(localVal); }
  function cancel() { setIsEditing(false); setLocalVal(value); }

  if (isEditing) {
    return multiline ? (
      <textarea
        ref={textareaRef}
        className="w-full text-sm bg-white border-0 outline-none p-0 leading-relaxed resize-none"
        value={localVal}
        onChange={(e) => { setLocalVal(e.target.value); autoResize(e.target); }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          if (e.key === 'Tab') { e.preventDefault(); save(); }
        }}
        autoFocus
      />
    ) : (
      <input
        type="text"
        className="w-full text-sm bg-white border-0 outline-none p-0 leading-relaxed"
        value={localVal}
        onChange={(e) => setLocalVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); save(); }
        }}
        autoFocus
      />
    );
  }

  return (
    <div
      data-cell-id={cellId}
      tabIndex={0}
      className="cursor-default outline-none w-full h-full min-h-[1.5em]"
      style={clampLines ? { maxHeight: `${clampLines * 1.6}em`, overflow: 'hidden' } : {}}
      onClick={() => onSelect(cellId)}
      onDoubleClick={startEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); startEdit(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); onNavigate('up'); }
        if (e.key === 'ArrowDown') { e.preventDefault(); onNavigate('down'); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); onNavigate('left'); }
        if (e.key === 'ArrowRight') { e.preventDefault(); onNavigate('right'); }
      }}
    >
      {renderDisplay ? renderDisplay(value) : (
        value ? <span className="text-sm text-gray-700">{value}</span> : <span className="text-gray-300 text-xs">—</span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`

---

### Task 2: Add TagsCell Component

**Files:**
- Modify: `frontend/src/pages/CardsPanel.tsx` (add after EditableCell)

- [ ] **Step 1: Add TagsCell component**

```tsx
interface TagsCellProps {
  tags: string[];
  cellId: string;
  onSave: (tags: string[]) => void;
  onSelect: (cellId: string) => void;
  onNavigate: (dir: 'up' | 'down' | 'left' | 'right') => void;
}

function TagsCell({ tags, cellId, onSave, onSelect, onNavigate }: TagsCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [localVal, setLocalVal] = useState(tags.join(', '));

  useEffect(() => { setLocalVal(tags.join(', ')); }, [tags]);

  function startEdit() { setLocalVal(tags.join(', ')); setIsEditing(true); }
  function save() {
    setIsEditing(false);
    const newTags = localVal.split(',').map(t => t.trim()).filter(Boolean);
    if (JSON.stringify(newTags) !== JSON.stringify(tags)) onSave(newTags);
  }
  function cancel() { setIsEditing(false); setLocalVal(tags.join(', ')); }

  if (isEditing) {
    return (
      <input
        type="text"
        className="w-full text-sm bg-white border-0 outline-none p-0 leading-relaxed"
        value={localVal}
        onChange={(e) => setLocalVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); save(); }
        }}
        autoFocus
      />
    );
  }

  return (
    <div
      data-cell-id={cellId}
      tabIndex={0}
      className="cursor-default outline-none w-full h-full flex flex-wrap gap-1"
      onClick={() => onSelect(cellId)}
      onDoubleClick={startEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); startEdit(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); onNavigate('up'); }
        if (e.key === 'ArrowDown') { e.preventDefault(); onNavigate('down'); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); onNavigate('left'); }
        if (e.key === 'ArrowRight') { e.preventDefault(); onNavigate('right'); }
      }}
    >
      {tags.length === 0 ? (
        <span className="text-gray-300 text-xs">—</span>
      ) : tags.map(tag => (
        <span key={tag} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200 font-medium">{tag}</span>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`

---

### Task 3: Add Cell Selection + Arrow Key Navigation to CardsPanel

**Files:**
- Modify: `frontend/src/pages/CardsPanel.tsx` — add refs and handlers to main component

- [ ] **Step 1: Add DOM-based cell selection state (refs, not React state)**

Add these inside the CardsPanel component, after existing state:

```tsx
// Cell selection (DOM refs for performance — no React re-render on click)
const tableContainerRef = useRef<HTMLDivElement>(null);
const selectedTdRef = useRef<HTMLElement | null>(null);

const handleCellSelect = useCallback((cellId: string) => {
  // Clear previous selection
  if (selectedTdRef.current) {
    selectedTdRef.current.style.boxShadow = '';
    selectedTdRef.current.style.position = '';
  }
  const [rowIdx, colId] = cellId.split(':');
  const td = tableContainerRef.current?.querySelector(
    `td[data-row="${rowIdx}"][data-col="${colId}"]`
  ) as HTMLElement | null;
  if (td) {
    td.style.boxShadow = 'inset 0 0 0 2px #3b82f6';
    td.style.position = 'relative';
    selectedTdRef.current = td;
  }
}, []);

const handleCellNavigate = useCallback((rowIndex: number, colId: string, dir: 'up' | 'down' | 'left' | 'right') => {
  const navigableCols = ['front_html', 'tags'];
  if (columnVisibility['extra'] !== false) navigableCols.push('extra');
  if (columnVisibility['vignette'] !== false) navigableCols.push('vignette');
  if (columnVisibility['teaching_case'] !== false) navigableCols.push('teaching_case');

  const colIdx = navigableCols.indexOf(colId);
  let newRow = rowIndex;
  let newCol = colId;
  const totalRows = table.getRowModel().rows.length;

  if (dir === 'up') newRow = Math.max(0, rowIndex - 1);
  if (dir === 'down') newRow = Math.min(totalRows - 1, rowIndex + 1);
  if (dir === 'left') newCol = navigableCols[Math.max(0, colIdx - 1)];
  if (dir === 'right') newCol = navigableCols[Math.min(navigableCols.length - 1, colIdx + 1)];

  const target = tableContainerRef.current?.querySelector(
    `[data-cell-id="${newRow}:${newCol}"]`
  ) as HTMLElement | null;
  target?.focus({ preventScroll: false });
  handleCellSelect(`${newRow}:${newCol}`);
}, [columnVisibility, table, handleCellSelect]);
```

- [ ] **Step 2: Add `data-row` and `data-col` attributes to `<td>` elements in the table render**

In the table `<tbody>` section, update the `<td>` element:

```tsx
<td
  key={cell.id}
  data-row={row.index}
  data-col={cell.column.id}
  className="px-3 py-2 align-top border border-gray-200"
  style={{ width: cell.column.getSize(), height: '1px', padding: cell.column.id === 'select' || cell.column.id === 'card_number' || cell.column.id === 'status' ? undefined : 0 }}
>
```

- [ ] **Step 3: Wrap the table `<div>` with `ref={tableContainerRef}`**

---

### Task 4: Rewrite Column Definitions with EditableCell/TagsCell

**Files:**
- Modify: `frontend/src/pages/CardsPanel.tsx` — rewrite the `columns` useMemo

- [ ] **Step 1: Add `showAnkiFormat` state and `searchQ` state**

```tsx
const [showAnkiFormat, setShowAnkiFormat] = useState(false);
const [searchQ, setSearchQ] = useState('');
```

- [ ] **Step 2: Add `stripHtmlKeepCloze` utility function (before CardsPanel component)**

```tsx
function stripHtmlKeepCloze(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}
```

- [ ] **Step 3: Add filtered cards memo**

```tsx
const filteredCards = useMemo(
  () => cards.filter(c => {
    if (searchQ.trim()) {
      const q = searchQ.toLowerCase();
      if (!c.front_text.toLowerCase().includes(q) &&
          !c.tags.some(t => t.toLowerCase().includes(q))) return false;
    }
    return true;
  }),
  [cards, searchQ]
);
```

Update TanStack table `data` from `cards` to `filteredCards`.

- [ ] **Step 4: Rewrite column definitions**

The `front_html` column uses EditableCell with Anki/Text toggle. The `tags` column uses TagsCell. `extra`, `vignette`, `teaching_case` use EditableCell with multiline + clamp. Each cell gets `onSelect={handleCellSelect}` and `onNavigate` wired to `handleCellNavigate`.

The `card_number` column gets a status dot and row resize handle (from v3). The `select` column gets inline action buttons (edit, reject, delete, regen) visible on hover.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`

---

### Task 5: Add Search Bar + Anki/Text Toggle to Toolbar

**Files:**
- Modify: `frontend/src/pages/CardsPanel.tsx` — toolbar section

- [ ] **Step 1: Add search input to toolbar**

After the status filter dropdown, add:

```tsx
{/* Global search */}
<div className="relative">
  <svg className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
  </svg>
  <input
    type="text"
    value={searchQ}
    onChange={(e) => setSearchQ(e.target.value)}
    placeholder="Search cards..."
    className="w-44 text-xs border border-gray-200 rounded-lg pl-7 pr-7 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
  />
  {searchQ && (
    <button onClick={() => setSearchQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  )}
</div>
```

- [ ] **Step 2: Add Anki/Text toggle (table view only)**

After the column visibility button, add:

```tsx
{viewMode === 'table' && (
  <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
    <button
      onClick={() => setShowAnkiFormat(false)}
      className={`px-2 py-1 text-xs font-medium ${!showAnkiFormat ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'}`}
    >
      Text
    </button>
    <button
      onClick={() => setShowAnkiFormat(true)}
      className={`px-2 py-1 text-xs font-medium ${showAnkiFormat ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'}`}
    >
      Anki
    </button>
  </div>
)}
```

---

### Task 6: Enhanced Selection Action Bar

**Files:**
- Modify: `frontend/src/pages/CardsPanel.tsx` — bulk actions in toolbar

- [ ] **Step 1: Expand the selection toolbar**

When `selectedIds.size > 0`, show an enhanced bar with:
- Selection count
- Ankify button (violet)
- Mark Reviewed button (green)
- Gen Vignettes & Cases button (indigo) — future, leave placeholder
- Discuss in Chat button (blue) — dispatches `discuss-cards` custom event
- Delete button (red)

---

### Task 7: Add CSS for Cell Selection

**Files:**
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Add focus styles**

```css
/* ── Cell selection in table view ── */
[data-cell-id]:focus {
  outline: none;
}
td[data-col] {
  transition: box-shadow 0.1s ease;
}
```

---

### Task 8: Final Integration + Verify

- [ ] **Step 1: Verify TypeScript compiles cleanly**

Run: `cd frontend && npx tsc --noEmit`

- [ ] **Step 2: Manual test checklist**
- Click a cell → blue border appears
- Arrow keys move between cells
- Double-click cell → edit mode with textarea
- Enter key → starts edit
- Escape → cancels edit
- Tab/blur → saves edit
- Search bar filters by front_text and tags
- Anki/Text toggle switches cloze rendering
- Select cards → action bar appears with all buttons
- Column visibility toggle works
- Card grid view still works
- Pagination still works
- Generation flow still works

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/CardsPanel.tsx frontend/src/index.css
git commit -m "feat: Excel-like grid with cell selection, inline edit, search, Anki toggle"
```
