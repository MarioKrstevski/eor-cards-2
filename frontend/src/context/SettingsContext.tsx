import { createContext, useContext, useState } from 'react';

interface Settings {
  selectedModel: string;
  setSelectedModel: (m: string) => void;
  vignetteModel: string;
  setVignetteModel: (m: string) => void;
  teachingCaseModel: string;
  setTeachingCaseModel: (m: string) => void;
  selectedRuleSetId: number | null;
  setSelectedRuleSetId: (id: number | null) => void;
  vignetteRuleSetId: number | null;
  setVignetteRuleSetId: (id: number | null) => void;
  teachingCaseRuleSetId: number | null;
  setTeachingCaseRuleSetId: (id: number | null) => void;
}

const defaults: Settings = {
  selectedModel: 'claude-sonnet-4-6',
  setSelectedModel: () => {},
  vignetteModel: 'claude-sonnet-4-6',
  setVignetteModel: () => {},
  teachingCaseModel: 'claude-sonnet-4-6',
  setTeachingCaseModel: () => {},
  selectedRuleSetId: null,
  setSelectedRuleSetId: () => {},
  vignetteRuleSetId: null,
  setVignetteRuleSetId: () => {},
  teachingCaseRuleSetId: null,
  setTeachingCaseRuleSetId: () => {},
};

export const SettingsContext = createContext<Settings>(defaults);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [selectedModel, setSelectedModelState] = useState<string>(
    () => localStorage.getItem('settings_model') || 'claude-sonnet-4-6'
  );
  const [vignetteModel, setVignetteModelState] = useState<string>(
    () => localStorage.getItem('settings_vignette_model') || 'claude-sonnet-4-6'
  );
  const [teachingCaseModel, setTeachingCaseModelState] = useState<string>(
    () => localStorage.getItem('settings_teaching_case_model') || 'claude-sonnet-4-6'
  );
  const [selectedRuleSetId, setSelectedRuleSetIdState] = useState<number | null>(() => {
    const v = localStorage.getItem('settings_ruleset');
    return v ? Number(v) : null;
  });
  const [vignetteRuleSetId, setVignetteRuleSetIdState] = useState<number | null>(() => {
    const v = localStorage.getItem('settings_vignette_ruleset');
    return v ? Number(v) : null;
  });
  const [teachingCaseRuleSetId, setTeachingCaseRuleSetIdState] = useState<number | null>(() => {
    const v = localStorage.getItem('settings_teaching_case_ruleset');
    return v ? Number(v) : null;
  });

  function setSelectedModel(m: string) {
    setSelectedModelState(m);
    localStorage.setItem('settings_model', m);
  }

  function setVignetteModel(m: string) {
    setVignetteModelState(m);
    localStorage.setItem('settings_vignette_model', m);
  }

  function setTeachingCaseModel(m: string) {
    setTeachingCaseModelState(m);
    localStorage.setItem('settings_teaching_case_model', m);
  }

  function setSelectedRuleSetId(id: number | null) {
    setSelectedRuleSetIdState(id);
    if (id == null) localStorage.removeItem('settings_ruleset');
    else localStorage.setItem('settings_ruleset', String(id));
  }

  function setVignetteRuleSetId(id: number | null) {
    setVignetteRuleSetIdState(id);
    if (id == null) localStorage.removeItem('settings_vignette_ruleset');
    else localStorage.setItem('settings_vignette_ruleset', String(id));
  }

  function setTeachingCaseRuleSetId(id: number | null) {
    setTeachingCaseRuleSetIdState(id);
    if (id == null) localStorage.removeItem('settings_teaching_case_ruleset');
    else localStorage.setItem('settings_teaching_case_ruleset', String(id));
  }

  return (
    <SettingsContext.Provider
      value={{
        selectedModel, setSelectedModel,
        vignetteModel, setVignetteModel,
        teachingCaseModel, setTeachingCaseModel,
        selectedRuleSetId, setSelectedRuleSetId,
        vignetteRuleSetId, setVignetteRuleSetId,
        teachingCaseRuleSetId, setTeachingCaseRuleSetId,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
