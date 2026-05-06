import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CurriculumNode } from '../types';

interface CurriculumPickerProps {
  flatNodes: CurriculumNode[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder?: string;
}

export default function CurriculumPicker({
  flatNodes,
  value,
  onChange,
  placeholder = '— unassigned —',
}: CurriculumPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });

  const selectedNode = value != null ? flatNodes.find((n) => n.id === value) : null;

  const filtered = query.trim()
    ? flatNodes.filter((n) => n.path.toLowerCase().includes(query.toLowerCase()))
    : flatNodes;

  // Position the dropdown based on the trigger element
  useEffect(() => {
    if (open && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    }
  }, [open]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        // Also check if the click is inside the portal dropdown
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
          <span className="flex-1 px-2 py-1 text-sm truncate text-gray-700">
            {selectedNode
              ? selectedNode.name
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
          className="fixed bg-white border border-gray-200 rounded-md shadow-xl overflow-hidden"
          style={{ top: dropdownPos.top, left: dropdownPos.left, width: Math.max(dropdownPos.width, 220), zIndex: 9999 }}
        >
          <div
            className="px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-50 cursor-pointer border-b border-gray-100"
            onMouseDown={(e) => { e.preventDefault(); onChange(null); setOpen(false); setQuery(''); }}
          >
            {placeholder}
          </div>
          <div className="max-h-60 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-gray-400 italic">No matches</p>
            ) : (
              filtered.map((n) => (
                <div
                  key={n.id}
                  onMouseDown={(e) => { e.preventDefault(); onChange(n.id); setOpen(false); setQuery(''); }}
                  className={[
                    'px-3 py-1.5 text-xs cursor-pointer truncate hover:bg-blue-50 hover:text-blue-800',
                    n.id === value ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700',
                    n.level === 0 ? 'font-semibold text-gray-900' : '',
                  ].join(' ')}
                  style={{ paddingLeft: `${(n.level + 1) * 10}px` }}
                  title={n.path}
                >
                  {n.name}
                </div>
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
