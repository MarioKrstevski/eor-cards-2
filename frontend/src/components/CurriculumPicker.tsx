import { useEffect, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { CurriculumNode } from '../types';

interface CurriculumPickerProps {
  flatNodes: CurriculumNode[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder?: string;
}

// Walk up parent_id chain to collect ancestor IDs
function getAncestorIds(nodeId: number, parentMap: Map<number, number | null>): Set<number> {
  const ancestors = new Set<number>();
  let cur = parentMap.get(nodeId) ?? null;
  while (cur != null) {
    ancestors.add(cur);
    cur = parentMap.get(cur) ?? null;
  }
  return ancestors;
}

const LEVEL_STYLES = [
  'bg-purple-50 text-purple-700',
  'bg-blue-50 text-blue-700',
  'bg-green-50 text-green-700',
  'bg-orange-50 text-orange-700',
];

interface PickerNodeProps {
  node: CurriculumNode;
  value: number | null;
  onChange: (id: number) => void;
  expandedIds: Set<number>;
  toggleExpand: (id: number) => void;
  matchIds: Set<number> | null;
  ancestorIds: Set<number>;
  // ancestors of the currently selected value (for persistent highlight)
  selectedAncestorIds: Set<number>;
}

function PickerNode({
  node, value, onChange, expandedIds, toggleExpand, matchIds, ancestorIds, selectedAncestorIds,
}: PickerNodeProps) {
  const hasChildren = node.children.length > 0;
  const isSelected = node.id === value;
  const isSelectedAncestor = selectedAncestorIds.has(node.id);

  // When searching: only render if this node matches or is an ancestor of a match
  if (matchIds !== null) {
    if (!matchIds.has(node.id) && !ancestorIds.has(node.id)) return null;
  }

  // During search: auto-expand ancestors; otherwise respect manual expand state
  const isExpanded = matchIds !== null
    ? ancestorIds.has(node.id) || matchIds.has(node.id)
    : expandedIds.has(node.id);

  const isDimmed = matchIds !== null && !matchIds.has(node.id) && ancestorIds.has(node.id);
  const levelStyle = LEVEL_STYLES[Math.min(node.level, 3)];

  return (
    <div>
      <div
        onMouseDown={(e) => { e.preventDefault(); onChange(node.id); }}
        className={[
          'flex items-center gap-1.5 py-1.5 pr-3 cursor-pointer select-none',
          isSelected
            ? 'bg-blue-200 text-blue-900'
            : isSelectedAncestor
            ? 'bg-blue-50 text-blue-800 hover:bg-blue-100'
            : isDimmed
            ? 'text-gray-400 hover:bg-gray-50'
            : 'text-gray-700 hover:bg-blue-50',
        ].join(' ')}
        style={{ paddingLeft: `${8 + node.level * 14}px` }}
      >
        {/* Expand/collapse arrow */}
        {hasChildren ? (
          <button
            onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); toggleExpand(node.id); }}
            className="w-3.5 h-3.5 flex items-center justify-center text-gray-400 hover:text-gray-600 shrink-0"
          >
            <svg
              className={`w-2.5 h-2.5 transition-transform duration-100 ${isExpanded ? 'rotate-90' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}

        {/* Level badge */}
        <span className={`text-[9px] font-bold w-4 text-center rounded shrink-0 py-px ${levelStyle}`}>
          {node.level + 1}
        </span>

        {/* Name */}
        <span className={`text-xs flex-1 truncate ${matchIds !== null && matchIds.has(node.id) ? 'font-semibold' : ''}`}>
          {node.name}
        </span>

        {/* Selected checkmark */}
        {isSelected && (
          <svg className="w-3 h-3 text-blue-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      {/* Children */}
      {hasChildren && isExpanded && node.children.map((child) => (
        <PickerNode
          key={child.id}
          node={child}
          value={value}
          onChange={onChange}
          expandedIds={expandedIds}
          toggleExpand={toggleExpand}
          matchIds={matchIds}
          ancestorIds={ancestorIds}
          selectedAncestorIds={selectedAncestorIds}
        />
      ))}
    </div>
  );
}

export default function CurriculumPicker({
  flatNodes,
  value,
  onChange,
  placeholder = '— unassigned —',
}: CurriculumPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{
    top?: number; bottom?: number; left: number; width: number;
  }>({ left: 0, width: 0 });

  const selectedNode = value != null ? flatNodes.find((n) => n.id === value) : null;

  // Root nodes to render the tree from
  const rootNodes = useMemo(() => flatNodes.filter((n) => n.level === 0), [flatNodes]);

  // Map nodeId → parentId for ancestor lookup
  const parentMap = useMemo(() => {
    const m = new Map<number, number | null>();
    for (const n of flatNodes) m.set(n.id, n.parent_id);
    return m;
  }, [flatNodes]);

  // Ancestors of the currently selected value — for persistent highlight
  const selectedAncestorIds = useMemo(
    () => value != null ? getAncestorIds(value, parentMap) : new Set<number>(),
    [value, parentMap]
  );

  // Compute which nodes match the search query and which are ancestors of matches
  const { matchIds, ancestorIds } = useMemo(() => {
    if (!query.trim()) return { matchIds: null, ancestorIds: new Set<number>() };

    const matches = new Set<number>();
    for (const n of flatNodes) {
      if (n.name.toLowerCase().includes(query.toLowerCase())) matches.add(n.id);
    }

    const ancestors = new Set<number>();
    for (const id of matches) {
      for (const aid of getAncestorIds(id, parentMap)) ancestors.add(aid);
    }

    return { matchIds: matches, ancestorIds: ancestors };
  }, [query, flatNodes, parentMap]);

  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSelect = (id: number) => {
    onChange(id);
    setOpen(false);
    setQuery('');
  };

  // Auto-expand ancestors of the selected node when opening
  useEffect(() => {
    if (open && selectedAncestorIds.size > 0) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        for (const id of selectedAncestorIds) next.add(id);
        return next;
      });
    }
  }, [open, selectedAncestorIds]);

  useEffect(() => {
    if (open && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const dropdownMaxHeight = 320;
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const spaceAbove = rect.top - 8;
      if (spaceBelow >= dropdownMaxHeight || spaceBelow >= spaceAbove) {
        // Open below, cap height to available space
        setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
      } else {
        // Open above
        setDropdownPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left, width: rect.width });
      }
    }
  }, [open]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        const dropdown = document.getElementById('curriculum-picker-dropdown');
        if (dropdown && dropdown.contains(e.target as Node)) return;
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Trigger */}
      <div
        className="flex items-center border border-gray-300 rounded-md bg-white cursor-pointer hover:border-blue-500 focus-within:ring-2 focus-within:ring-blue-600 focus-within:border-transparent transition-colors"
        onClick={() => { setOpen((v) => !v); setQuery(''); }}
      >
        {open ? (
          <input
            autoFocus
            className="flex-1 px-2 py-1 text-sm outline-none bg-transparent"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 px-2 py-1 text-sm truncate">
            {selectedNode
              ? <span className="text-gray-700">{selectedNode.name}</span>
              : <span className="text-gray-400">{placeholder}</span>
            }
          </span>
        )}
        <svg className="w-3.5 h-3.5 text-gray-400 mr-2 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {open && createPortal(
        <div
          id="curriculum-picker-dropdown"
          className="fixed bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden flex flex-col"
          style={{
            ...(dropdownPos.bottom != null
              ? { bottom: dropdownPos.bottom }
              : { top: dropdownPos.top }),
            left: dropdownPos.left,
            width: Math.max(dropdownPos.width, 300),
            zIndex: 9999,
            maxHeight: 320,
          }}
        >
          {/* Unassigned option */}
          <div
            className="px-3 py-2 text-xs text-gray-400 hover:bg-gray-50 cursor-pointer border-b border-gray-100 shrink-0"
            onMouseDown={(e) => { e.preventDefault(); onChange(null); setOpen(false); setQuery(''); }}
          >
            {placeholder}
          </div>

          {/* Tree */}
          <div className="overflow-y-auto flex-1">
            {rootNodes.length === 0 ? (
              <p className="px-3 py-2 text-xs text-gray-400 italic">No topics loaded</p>
            ) : matchIds !== null && matchIds.size === 0 ? (
              <p className="px-3 py-2 text-xs text-gray-400 italic">No matches for "{query}"</p>
            ) : (
              rootNodes.map((node) => (
                <PickerNode
                  key={node.id}
                  node={node}
                  value={value}
                  onChange={handleSelect}
                  expandedIds={expandedIds}
                  toggleExpand={toggleExpand}
                  matchIds={matchIds}
                  ancestorIds={ancestorIds}
                  selectedAncestorIds={selectedAncestorIds}
                />
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
