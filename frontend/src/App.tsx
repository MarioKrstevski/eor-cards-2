import { useEffect, useState, useRef } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { SettingsProvider, useSettings } from './context/SettingsContext';
import WorkspacePage from './pages/WorkspacePage';
import LibraryPage from './pages/LibraryPage';
import ProposalsPage from './pages/ProposalsPage';
import SettingsPopover from './components/SettingsPopover';
import UsageModal from './components/UsageModal';
import CostFlash from './components/CostFlash';
import HelpChat from './components/HelpChat';
import { getUsageSummary, getRuleSets } from './api';
import { APP_VERSION } from './version';

function AppInner() {
  const [showSettings, setShowSettings] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [displayedCost, setDisplayedCost] = useState<number | null>(null);
  const prevCostRef = useRef(0);
  const { selectedRuleSetId, setSelectedRuleSetId, curriculumVersion, setCurriculumVersion } = useSettings();

  function refreshUsage() {
    const prev = prevCostRef.current;
    getUsageSummary()
      .then((s) => {
        const next = s.total_cost_usd;
        const diff = next - prev;
        prevCostRef.current = next;
        if (diff > 0.000001 && prev > 0) {
          window.dispatchEvent(
            new CustomEvent('costIncurred', {
              detail: { cost: diff, prevTotal: prev, newTotal: next },
            })
          );
        } else {
          setDisplayedCost(next);
        }
      })
      .catch(() => {});
  }

  useEffect(() => {
    function onProgress(e: Event) {
      setDisplayedCost((e as CustomEvent<{ value: number }>).detail.value);
    }
    function onComplete(e: Event) {
      setDisplayedCost((e as CustomEvent<{ newTotal: number }>).detail.newTotal);
      refreshUsage();
    }
    function onChatCost(e: Event) {
      const { cost, originX, originY } = (
        e as CustomEvent<{ cost: number; originX?: number; originY?: number }>
      ).detail;
      if (cost < 0.000001) return;
      const prev = prevCostRef.current;
      const next = prev + cost;
      prevCostRef.current = next;
      window.dispatchEvent(
        new CustomEvent('costIncurred', {
          detail: { cost, prevTotal: prev, newTotal: next, originX, originY },
        })
      );
    }
    window.addEventListener('costProgress', onProgress);
    window.addEventListener('costComplete', onComplete);
    window.addEventListener('chatCostIncurred', onChatCost);
    return () => {
      window.removeEventListener('costProgress', onProgress);
      window.removeEventListener('costComplete', onComplete);
      window.removeEventListener('chatCostIncurred', onChatCost);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    getRuleSets()
      .then((sets) => {
        const validIds = new Set(sets.map((s) => s.id));
        if (selectedRuleSetId == null || !validIds.has(selectedRuleSetId)) {
          const def = sets.find((s) => s.is_default) ?? sets[0];
          if (def) setSelectedRuleSetId(def.id);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    isActive
      ? 'text-xs font-medium px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 transition-colors duration-150'
      : 'text-xs font-medium px-2.5 py-1 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-50 transition-colors duration-150';

  return (
    <div className="flex flex-col h-screen">
      <nav className="h-11 bg-white flex items-center px-5 gap-2 shrink-0 z-30 shadow-[0_1px_3px_0_rgba(0,0,0,0.05)]">
        <span className="flex items-center gap-1.5 mr-3">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-700" />
          <span className="text-xs font-bold tracking-tight text-gray-900">EOR Cards</span>
        </span>
        <NavLink to="/" end className={navLinkClass}>
          Workspace
        </NavLink>
        <NavLink to="/library" className={navLinkClass}>
          Library
        </NavLink>
        <NavLink to="/proposals" className={navLinkClass}>
          Proposals
        </NavLink>
        <div className="flex-1" />

        {/* Curriculum version toggle */}
        <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden mr-1" title="Active curriculum version">
          <button
            onClick={() => setCurriculumVersion('v1')}
            className={`px-2 py-1 text-[11px] font-medium transition-colors duration-150 ${curriculumVersion === 'v1' ? 'bg-blue-50 text-blue-700' : 'text-gray-400 hover:bg-gray-50'}`}
          >
            New
          </button>
          <button
            onClick={() => setCurriculumVersion('v2')}
            className={`px-2 py-1 text-[11px] font-medium transition-colors duration-150 ${curriculumVersion === 'v2' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-400 hover:bg-gray-50'}`}
          >
            Old
          </button>
        </div>

        <span className="text-[10px] text-gray-300 font-mono mr-2">v{APP_VERSION}</span>

        {displayedCost != null && (
          <button
            onClick={() => setShowUsage(true)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 px-2.5 py-1 rounded-lg hover:bg-gray-50 transition-colors duration-150 tabular-nums font-medium"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-3.5 w-3.5 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            ${displayedCost.toFixed(3)}
          </button>
        )}

        <button
          onClick={() => setShowSettings(true)}
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors duration-150"
          title="Settings"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
            />
          </svg>
        </button>
      </nav>

      <Routes>
        <Route path="/" element={<WorkspacePage refreshUsage={refreshUsage} />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/proposals" element={<ProposalsPage />} />
      </Routes>

      {showSettings && <SettingsPopover onClose={() => setShowSettings(false)} />}
      {showUsage && <UsageModal onClose={() => setShowUsage(false)} />}
      <CostFlash />
    </div>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <BrowserRouter>
        <AppInner />
        <HelpChat />
      </BrowserRouter>
    </SettingsProvider>
  );
}
