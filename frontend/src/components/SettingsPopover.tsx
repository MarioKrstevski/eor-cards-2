import { useEffect, useRef, useState } from 'react';
import { getModels, getRuleSets } from '../api';
import type { Model, RuleSet } from '../types';
import { useSettings } from '../context/SettingsContext';

export default function SettingsPopover({ onClose }: { onClose: () => void }) {
  const {
    selectedModel, setSelectedModel,
    vignetteModel, setVignetteModel,
    selectedRuleSetId, setSelectedRuleSetId,
    vignetteRuleSetId, setVignetteRuleSetId,
  } = useSettings();
  const [models, setModels] = useState<Model[]>([]);
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([getModels(), getRuleSets()])
      .then(([ms, rs]) => {
        setModels(ms);
        setRuleSets(rs);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
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

  const generationRules = ruleSets.filter((rs) => rs.rule_type === 'generation');
  const vignetteRules = ruleSets.filter((rs) => rs.rule_type === 'vignette');

  const selectClass =
    'text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors duration-150';
  const labelClass = 'text-[10px] font-semibold text-gray-400 uppercase tracking-wider';
  const sectionHeaderClass = 'text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-100 pb-1 mb-2';

  function ModelSelect({ value, onChange, fallback }: { value: string; onChange: (v: string) => void; fallback: string }) {
    return (
      <select className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
        {models.map((m) => (
          <option key={m.id} value={m.id}>{modelLabel(m)}</option>
        ))}
        {models.length === 0 && <option value={fallback}>{fallback}</option>}
      </select>
    );
  }

  function RulesSelect({
    value,
    onChange,
    options,
  }: {
    value: number | null;
    onChange: (id: number | null) => void;
    options: RuleSet[];
  }) {
    return (
      <select
        className={selectClass}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">-- none -- (use default)</option>
        {options.map((rs) => (
          <option key={rs.id} value={rs.id}>
            {rs.name}{rs.is_default ? ' (default)' : ''}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="fixed inset-0 z-50" aria-modal="true" role="dialog">
      <div className="absolute inset-0" />
      <div
        ref={panelRef}
        className="absolute top-14 right-3 w-80 bg-white rounded-xl shadow-xl border border-gray-200 overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">Settings</h2>
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
          {loading ? (
            <p className="text-xs text-gray-400 text-center py-2">Loading...</p>
          ) : (
            <>
              {/* Card Generation section */}
              <div>
                <p className={sectionHeaderClass}>Card Generation</p>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label className={labelClass}>Model</label>
                    <ModelSelect value={selectedModel} onChange={setSelectedModel} fallback={selectedModel} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className={labelClass}>Rules</label>
                    <RulesSelect value={selectedRuleSetId} onChange={setSelectedRuleSetId} options={generationRules} />
                  </div>
                </div>
              </div>

              {/* Supplemental (Vignettes + Teaching Cases) section */}
              <div>
                <p className={sectionHeaderClass}>Vignette + Teaching Case</p>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label className={labelClass}>Model</label>
                    <ModelSelect value={vignetteModel} onChange={setVignetteModel} fallback={vignetteModel} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className={labelClass}>Rules</label>
                    <RulesSelect value={vignetteRuleSetId} onChange={setVignetteRuleSetId} options={vignetteRules} />
                  </div>
                </div>
              </div>

              <p className="text-[10px] text-gray-400">Saved automatically to localStorage.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
