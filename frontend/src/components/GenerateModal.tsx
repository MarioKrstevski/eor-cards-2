import { useEffect, useMemo, useRef, useState } from 'react';
import type { Model, RuleSet } from '../types';
import { useSettings } from '../context/SettingsContext';
import { SIMPLE_MODELS } from '../constants';

export interface GenerateParams {
  model: string;
  rule_set_id: number;
  card_version: string;
  replace_existing: boolean;
}

interface GenerateModalProps {
  models: Model[];
  ruleSets: RuleSet[];        // full rule-set list; filtered internally to shown generation rules
  estimateLabel?: string | null;  // optional cost hint, e.g. "~$0.123"
  onGenerate: (params: GenerateParams) => void;
  onClose: () => void;
}

const CARD_VERSIONS: { value: string; label: string }[] = [
  { value: 'base', label: 'Base' },
  { value: 'v1', label: 'V1' },
  { value: 'v2', label: 'V2' },
  { value: 'v3', label: 'V3' },
];

/** A model id may carry an effort suffix ("claude-sonnet-4-5:medium"); the
 * whitelist is by bare id, so match on the prefix before the colon. */
function modelInSimple(id: string): boolean {
  const bare = id.split(':')[0];
  return SIMPLE_MODELS.includes(bare);
}

export default function GenerateModal({ models, ruleSets, estimateLabel, onGenerate, onClose }: GenerateModalProps) {
  const { selectedModel, selectedRuleSetId, simpleView } = useSettings();
  const panelRef = useRef<HTMLDivElement>(null);

  const shownGenRules = useMemo(
    () => ruleSets.filter((rs) => rs.rule_type === 'generation' && rs.is_shown),
    [ruleSets]
  );

  const modelOptions = useMemo(
    () => (simpleView ? models.filter((m) => modelInSimple(m.id)) : models),
    [models, simpleView]
  );

  const [model, setModel] = useState<string>(() => {
    if (simpleView && !modelInSimple(selectedModel)) return 'claude-sonnet-4-5';
    return selectedModel;
  });

  const [ruleSetId, setRuleSetId] = useState<number | null>(() => {
    const current = shownGenRules.find((r) => r.id === selectedRuleSetId);
    if (current) return current.id;
    const def = shownGenRules.find((r) => r.is_default);
    return def?.id ?? shownGenRules[0]?.id ?? null;
  });

  const [cardVersion, setCardVersion] = useState<string>('base');
  // Default ON: re-generating a section replaces its cards (avoids stacking a
  // second run's output on top of the first — the 32→49 append surprise).
  const [replaceExisting, setReplaceExisting] = useState<boolean>(true);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  function modelLabel(m: Model) {
    return `${m.display} ($${m.input_per_1m.toFixed(2)}/$${m.output_per_1m.toFixed(2)})`;
  }

  const canGenerate = ruleSetId != null && !!model;

  function handleSubmit() {
    if (ruleSetId == null || !model) return;
    onGenerate({ model, rule_set_id: ruleSetId, card_version: cardVersion, replace_existing: replaceExisting });
  }

  const selectClass =
    'text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors duration-150';
  const labelClass = 'text-[10px] font-semibold text-gray-400 uppercase tracking-wider';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" aria-modal="true" role="dialog">
      <div className="absolute inset-0 bg-black/30" />
      <div
        ref={panelRef}
        className="relative w-96 max-w-[90vw] bg-white rounded-xl shadow-xl border border-gray-200 overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">Generate Cards</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-50 transition-colors duration-150"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4">
          {/* Model */}
          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>Model</label>
            <select className={selectClass} value={model} onChange={(e) => setModel(e.target.value)}>
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>{modelLabel(m)}</option>
              ))}
              {modelOptions.length === 0 && <option value={model}>{model}</option>}
            </select>
          </div>

          {/* Rule set */}
          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>Rule set</label>
            <select
              className={selectClass}
              value={ruleSetId ?? ''}
              onChange={(e) => setRuleSetId(e.target.value ? Number(e.target.value) : null)}
            >
              {shownGenRules.length === 0 && <option value="">-- no shown rule sets --</option>}
              {shownGenRules.map((rs) => (
                <option key={rs.id} value={rs.id}>
                  {rs.name}{rs.is_default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Target version */}
          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>Target version</label>
            <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden self-start">
              {CARD_VERSIONS.map((v) => (
                <button
                  key={v.value}
                  type="button"
                  onClick={() => setCardVersion(v.value)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors duration-150 ${
                    cardVersion === v.value
                      ? 'bg-blue-700 text-white'
                      : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-400">Generated front + extra are written to this version slot.</p>
          </div>

          {/* Replace existing */}
          <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={replaceExisting}
              onChange={(e) => setReplaceExisting(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-gray-300 text-blue-700 focus:ring-blue-600"
            />
            Replace existing cards
          </label>

          {estimateLabel && <p className="text-[10px] text-gray-400">Estimated cost: {estimateLabel}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors duration-150"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canGenerate}
            className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors duration-150"
          >
            Generate
          </button>
        </div>
      </div>
    </div>
  );
}
