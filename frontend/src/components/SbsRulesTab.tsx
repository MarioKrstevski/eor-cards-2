import { useEffect, useState } from 'react';
import type { SbsRuleSet, SbsSection } from '../types';
import { listSbsRules, updateSbsRule, createSbsRule, deleteSbsRule, apiErrorMessage } from '../api';

/**
 * Step-by-Step rule editor. The prompt is ONE rule set, but stored as sections
 * each assigned to a phase (segment / author / shared). Editing a section here
 * changes only what that phase sends — the pieces flow to the right step
 * automatically. Fully separate from the normal Rules tab / table.
 */
const PHASES: SbsSection['phase'][] = ['segment', 'author', 'shared'];
const PHASE_HINT: Record<SbsSection['phase'], string> = {
  segment: 'Step 1 — decides units (standalone vs sibling)',
  author: 'Step 2 — writes the cloze card text',
  shared: 'Sent to both steps',
};
const PHASE_COLOR: Record<SbsSection['phase'], string> = {
  segment: 'bg-blue-50 text-blue-700 border-blue-200',
  author: 'bg-violet-50 text-violet-700 border-violet-200',
  shared: 'bg-gray-100 text-gray-600 border-gray-200',
};

export default function SbsRulesTab() {
  const [view, setView] = useState<'workflow' | 'prompts'>('workflow');
  const [rules, setRules] = useState<SbsRuleSet[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [draft, setDraft] = useState<SbsSection[]>([]);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const rs = await listSbsRules();
      setRules(rs);
      if (selId == null && rs.length) select(rs[0]);
    } catch (e) { setError(apiErrorMessage(e, 'Failed to load')); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  function select(r: SbsRuleSet) {
    setSelId(r.id);
    setName(r.name);
    setDraft(r.sections.map((s) => ({ ...s })));
    setDirty(false);
  }

  function setSection(i: number, patch: Partial<SbsSection>) {
    setDraft((d) => d.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
    setDirty(true);
  }

  async function save() {
    if (selId == null) return;
    setSaving(true); setError(null);
    try {
      await updateSbsRule(selId, { name, sections: draft });
      setDirty(false);
      await load();
    } catch (e) { setError(apiErrorMessage(e, 'Save failed')); }
    finally { setSaving(false); }
  }

  async function duplicate() {
    if (selId == null) return;
    try {
      const copy = await createSbsRule(`${name} (copy)`, draft);
      await load();
      select(copy);
    } catch (e) { setError(apiErrorMessage(e, 'Duplicate failed')); }
  }

  async function makeDefault() {
    if (selId == null) return;
    try { await updateSbsRule(selId, { is_default: true }); await load(); }
    catch (e) { setError(apiErrorMessage(e, 'Failed')); }
  }

  async function remove() {
    if (selId == null) return;
    if (!window.confirm('Delete this step-by-step rule set?')) return;
    try { await deleteSbsRule(selId); setSelId(null); setDraft([]); await load(); }
    catch (e) { setError(apiErrorMessage(e, 'Delete failed')); }
  }

  const selected = rules.find((r) => r.id === selId);
  const phaseCount = (p: string) => draft.filter((s) => s.phase === p).length;

  return (
    <div className="flex flex-col h-[calc(100vh-200px)]">
      {/* sub-view toggle */}
      <div className="flex items-center gap-1.5 pb-3 shrink-0">
        {(['workflow', 'prompts'] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={`px-3 py-1 text-xs font-medium rounded-lg border transition-colors ${view === v ? 'bg-indigo-50 text-indigo-700 border-indigo-300' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
            {v === 'workflow' ? 'How it works' : 'Prompt (the parts)'}
          </button>
        ))}
      </div>

      {view === 'workflow' ? (
        <div className="overflow-y-auto pr-2 max-w-3xl space-y-4 text-sm text-gray-700">
          <div>
            <h3 className="text-sm font-bold text-gray-900">What "Step by Step" does</h3>
            <p className="text-xs text-gray-600 mt-1">
              Instead of one big call that does everything at once (and drops rules while it juggles),
              the section runs through <b>three focused steps</b>. Each AI step sees only the rules it needs.
              The formatting/footers are done in <b>code</b> so they can't be forgotten.
            </p>
          </div>

          <Step n="1" title="Segment (AI)" color="bg-blue-50 border-blue-200">
            Reads the section's faithful source text and decides the <b>units</b>: which pieces are
            <b> standalone cards</b> and which are <b>sibling sets</b>. For each unit it records the
            verbatim source text of every member and the footer label. It does <b>not</b> write cards yet —
            it only produces the plan. <br /><span className="text-gray-500">Uses the prompt sections tagged <b>segment</b> (currently {phaseCount('segment')}) + <b>shared</b> ({phaseCount('shared')}).</span>
          </Step>
          <Step n="2" title="Author (AI)" color="bg-violet-50 border-violet-200">
            Given the plan, writes the <b>cloze card text</b> for each member — rewording, cloze placement,
            styling. For a sibling member the stem contains only that member (the footer is added by code).
            <br /><span className="text-gray-500">Uses the prompt sections tagged <b>author</b> (currently {phaseCount('author')}) + <b>shared</b>.</span>
          </Step>
          <Step n="3" title="Assemble (code, no AI)" color="bg-gray-50 border-gray-200">
            Deterministic finish: builds each <b>sibling footer</b> from the plan's other members
            (so it's always complete), sets a <b>blank Column 3</b> for standalone cards, and normalizes
            every cloze to <b>c1</b>. Then the cards are saved into the version you chose.
          </Step>

          <div className="border-t border-gray-100 pt-3 text-xs text-gray-600 space-y-1">
            <p>• You trigger it from a section with <b>Generate — Step by Step</b> in the card panel, choose a prompt and where the cards go, glance at what each step will send, and hit Continue.</p>
            <p>• When it finishes you can <b>download a .md audit</b> ("&lt;section&gt; SBS.md") with every step's prompt, input, and output — hand it to an AI to ask "why did it go wrong here."</p>
            <p>• The default prompt is <b>seeded</b> for you. Duplicate it to make variants. Editing a section's <b>phase tag</b> (in "Prompt (the parts)") moves that piece to a different step.</p>
          </div>
        </div>
      ) : (
    <div className="flex gap-4 flex-1 min-h-0">
      {/* rule set list */}
      <div className="w-56 shrink-0 border border-gray-200 rounded-xl p-2 overflow-y-auto">
        <div className="text-[11px] font-semibold text-gray-400 uppercase px-1 pb-1">Step-by-Step rule sets</div>
        {rules.map((r) => (
          <button key={r.id} onClick={() => select(r)}
            className={`w-full text-left px-2 py-1.5 rounded-lg text-xs mb-0.5 ${selId === r.id ? 'bg-indigo-50 text-indigo-700 font-semibold' : 'text-gray-700 hover:bg-gray-50'}`}>
            {r.name}{r.is_default ? ' ★' : ''}
          </button>
        ))}
        {rules.length === 0 && <p className="text-[11px] text-gray-400 px-1">None yet.</p>}
      </div>

      {/* editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected ? (
          <>
            <div className="flex items-center gap-2 pb-2">
              <input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }}
                className="text-sm font-semibold border border-gray-200 rounded-lg px-2 py-1 flex-1 focus:outline-none focus:ring-2 focus:ring-indigo-400" />
              {!selected.is_default && <button onClick={makeDefault} className="text-[11px] px-2 py-1 rounded-lg border border-gray-200 hover:bg-gray-50">Set default</button>}
              <button onClick={duplicate} className="text-[11px] px-2 py-1 rounded-lg border border-gray-200 hover:bg-gray-50">Duplicate</button>
              <button onClick={remove} className="text-[11px] px-2 py-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50">Delete</button>
              <button onClick={save} disabled={!dirty || saving}
                className="text-[11px] px-3 py-1 rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40">
                {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </button>
            </div>
            {error && <p className="text-[11px] text-red-600 pb-1">{error}</p>}
            <p className="text-[11px] text-gray-500 pb-2">
              Each section is sent only to its phase. Edit the text, or reassign a section to a different step.
            </p>
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {draft.map((s, i) => (
                <div key={i} className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-100">
                    <span className="text-xs font-semibold text-gray-700 flex-1 truncate">{s.heading}</span>
                    <select value={s.phase} onChange={(e) => setSection(i, { phase: e.target.value as SbsSection['phase'] })}
                      className={`text-[11px] rounded-md border px-1.5 py-0.5 ${PHASE_COLOR[s.phase]}`}>
                      {PHASES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div className="px-3 py-1 text-[10px] text-gray-400">{PHASE_HINT[s.phase]}</div>
                  <textarea value={s.text} onChange={(e) => setSection(i, { text: e.target.value })}
                    rows={Math.min(14, Math.max(3, s.text.split('\n').length))}
                    className="w-full text-[11px] font-mono px-3 py-2 border-t border-gray-100 focus:outline-none resize-y" />
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-xs text-gray-400 py-8 text-center">Select a step-by-step rule set to edit.</p>
        )}
      </div>
    </div>
      )}
    </div>
  );
}

function Step({ n, title, color, children }: { n: string; title: string; color: string; children: React.ReactNode }) {
  return (
    <div className={`border rounded-xl p-3 ${color}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="w-5 h-5 rounded-full bg-white/70 text-gray-700 text-[11px] font-bold flex items-center justify-center border border-gray-300">{n}</span>
        <span className="text-sm font-bold text-gray-900">{title}</span>
      </div>
      <p className="text-xs text-gray-700 leading-relaxed">{children}</p>
    </div>
  );
}
