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
  curriculumVersion: string;
  setCurriculumVersion: (v: string) => void;
  activeTagSet: 'old' | 'new';
  setActiveTagSet: (v: 'old' | 'new') => void;
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
  curriculumVersion: 'v2',
  setCurriculumVersion: () => {},
  activeTagSet: 'old',
  setActiveTagSet: () => {},
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
  const [curriculumVersion, setCurriculumVersionState] = useState<string>(
    () => localStorage.getItem('settings_curriculum_version') || 'v2'
  );
  const [activeTagSet, setActiveTagSetState] = useState<'old' | 'new'>(
    () => (localStorage.getItem('settings_active_tag_set') as 'old' | 'new') || 'old'
  );

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

  function setCurriculumVersion(v: string) {
    setCurriculumVersionState(v);
    localStorage.setItem('settings_curriculum_version', v);
  }

  function setActiveTagSet(v: 'old' | 'new') {
    setActiveTagSetState(v);
    localStorage.setItem('settings_active_tag_set', v);
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
        curriculumVersion, setCurriculumVersion,
        activeTagSet, setActiveTagSet,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
