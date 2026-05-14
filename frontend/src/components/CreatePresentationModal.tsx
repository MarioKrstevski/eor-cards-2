import { useState } from 'react';
import { createPresentation } from '../api';
import type { Presentation } from '../types';

interface CreatePresentationModalProps {
  selectedCardIds: number[];          // for source_type='cards'
  topicTreeId: number | null;         // for source_type='topic'
  onCreated: (p: Presentation) => void;
  onClose: () => void;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const VERSION_OPTIONS: { value: 'base' | 'v1' | 'v2' | 'v3'; label: string }[] = [
  { value: 'base', label: 'Base' },
  { value: 'v1',   label: 'V1' },
  { value: 'v2',   label: 'V2' },
  { value: 'v3',   label: 'V3' },
];

export default function CreatePresentationModal({
  selectedCardIds,
  topicTreeId,
  onCreated,
  onClose,
}: CreatePresentationModalProps) {
  const [name, setName] = useState('');
  const [cardVersion, setCardVersion] = useState<'base' | 'v1' | 'v2' | 'v3'>('base');
  const [sourceType, setSourceType] = useState<'cards' | 'topic'>(
    selectedCardIds.length > 0 ? 'cards' : 'topic'
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const derivedSlug = slugify(name);

  async function handleCreate() {
    if (!name.trim()) { setError('Name is required'); return; }
    if (sourceType === 'cards' && selectedCardIds.length === 0) { setError('No cards selected'); return; }
    if (sourceType === 'topic' && !topicTreeId) { setError('No topic selected'); return; }
    setSaving(true);
    setError(null);
    try {
      const p = await createPresentation({
        name: name.trim(),
        card_version: cardVersion,
        source_type: sourceType,
        card_ids: sourceType === 'cards' ? selectedCardIds : null,
        topic_tree_id: sourceType === 'topic' ? topicTreeId : null,
      });
      onCreated(p);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Failed to create presentation';
      setError(msg);
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[440px] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Create Ankify Presentation</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-50">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 flex flex-col gap-4">
          {/* Name */}
          <div>
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">Name</label>
            <input
              autoFocus
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors duration-150"
              placeholder="e.g. Cardiology Exam Prep"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
            />
            {derivedSlug && (
              <p className="text-[10px] text-gray-400 mt-1">
                URL: <span className="font-mono">/anki/{derivedSlug}</span>
              </p>
            )}
          </div>

          {/* Card version */}
          <div>
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">Card Version</label>
            <div className="flex items-center gap-1">
              {VERSION_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setCardVersion(opt.value)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors duration-150 ${
                    cardVersion === opt.value
                      ? 'bg-violet-50 border-violet-300 text-violet-700'
                      : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Source */}
          <div>
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">Source</label>
            <div className="flex flex-col gap-1.5">
              {selectedCardIds.length > 0 && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={sourceType === 'cards'}
                    onChange={() => setSourceType('cards')}
                    className="accent-violet-600"
                  />
                  <span className="text-sm text-gray-700">
                    Selected cards <span className="text-gray-400">({selectedCardIds.length} cards)</span>
                  </span>
                </label>
              )}
              {topicTreeId && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={sourceType === 'topic'}
                    onChange={() => setSourceType('topic')}
                    className="accent-violet-600"
                  />
                  <span className="text-sm text-gray-700">
                    Entire topic <span className="text-gray-400">(all active cards in this topic)</span>
                  </span>
                </label>
              )}
            </div>
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-xs font-medium text-gray-600 hover:text-gray-800 transition-colors duration-150">
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={saving || !name.trim()}
            className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors duration-150"
          >
            {saving ? 'Creating...' : 'Create Presentation'}
          </button>
        </div>
      </div>
    </div>
  );
}
