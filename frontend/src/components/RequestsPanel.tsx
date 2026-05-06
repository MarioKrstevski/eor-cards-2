import { useState, useEffect, useRef } from 'react';
import { getRequests, createRequest, completeRequest, deleteRequest, refineRequest, type FeatureRequestItem } from '../api';

export default function RequestsPanel() {
  const [tab, setTab] = useState<'upcoming' | 'done'>('upcoming');
  const [requests, setRequests] = useState<FeatureRequestItem[]>([]);
  const [loading, setLoading] = useState(true);

  // New request form
  const [showNew, setShowNew] = useState(false);
  const [refineMessages, setRefineMessages] = useState<{ role: string; content: string }[]>([]);
  const [refineInput, setRefineInput] = useState('');
  const [refineLoading, setRefineLoading] = useState(false);
  const [refineDone, setRefineDone] = useState<{ title: string; description: string } | null>(null);
  const refineEndRef = useRef<HTMLDivElement>(null);

  // Complete modal
  const [completeId, setCompleteId] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [completeError, setCompleteError] = useState('');

  useEffect(() => { loadRequests(); }, []);
  useEffect(() => { refineEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [refineMessages]);

  async function loadRequests() {
    setLoading(true);
    try {
      const all = await getRequests();
      setRequests(all);
    } catch { /* ignore */ }
    setLoading(false);
  }

  const pending = requests.filter(r => r.status === 'pending');
  const done = requests.filter(r => r.status === 'done');

  async function handleRefineSubmit() {
    const text = refineInput.trim();
    if (!text || refineLoading) return;

    const msgs = [...refineMessages, { role: 'user' as const, content: text }];
    setRefineMessages(msgs);
    setRefineInput('');
    setRefineLoading(true);

    try {
      const reply = await refineRequest(msgs);
      setRefineMessages([...msgs, { role: 'assistant', content: reply }]);

      // Check if AI generated a final request
      const titleMatch = reply.match(/===TITLE===\s*([\s\S]*?)===DESCRIPTION===/);
      const descMatch = reply.match(/===DESCRIPTION===\s*([\s\S]*?)$/);
      if (titleMatch && descMatch) {
        setRefineDone({ title: titleMatch[1].trim(), description: descMatch[1].trim() });
      }
    } catch {
      setRefineMessages([...msgs, { role: 'assistant', content: 'Sorry, something went wrong.' }]);
    } finally {
      setRefineLoading(false);
    }
  }

  async function handleSaveRequest() {
    if (!refineDone) return;
    try {
      await createRequest({ title: refineDone.title, description: refineDone.description, source: 'manual' });
      setShowNew(false);
      setRefineMessages([]);
      setRefineDone(null);
      loadRequests();
    } catch { /* ignore */ }
  }

  async function handleComplete() {
    if (!completeId) return;
    setCompleteError('');
    try {
      await completeRequest(completeId, password);
      setCompleteId(null);
      setPassword('');
      loadRequests();
    } catch {
      setCompleteError('Incorrect password');
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteRequest(id);
      setRequests(prev => prev.filter(r => r.id !== id));
    } catch { /* ignore */ }
  }

  function startNewRequest() {
    setShowNew(true);
    setRefineMessages([]);
    setRefineDone(null);
    setRefineInput('');
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 shrink-0">
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
          <button
            onClick={() => setTab('upcoming')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${tab === 'upcoming' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            Upcoming ({pending.length})
          </button>
          <button
            onClick={() => setTab('done')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${tab === 'done' ? 'bg-white text-green-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            Done ({done.length})
          </button>
        </div>
        <button
          onClick={startNewRequest}
          className="text-xs text-blue-700 hover:text-blue-900 font-medium"
        >
          + New Request
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5">
        {loading ? (
          <p className="text-xs text-gray-400 text-center py-8">Loading...</p>
        ) : showNew ? (
          /* ── New Request Form (AI-guided) ── */
          <div className="max-w-lg mx-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-900">New Feature Request</h3>
              <button onClick={() => setShowNew(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
            </div>

            {refineDone ? (
              /* Final request preview */
              <div className="border-2 border-green-200 rounded-xl p-4 bg-green-50 mb-4">
                <p className="text-xs text-green-600 font-semibold uppercase tracking-wide mb-2">Request Ready</p>
                <h4 className="text-sm font-bold text-gray-900 mb-1">{refineDone.title}</h4>
                <p className="text-sm text-gray-700 leading-relaxed">{refineDone.description}</p>
                <button
                  onClick={handleSaveRequest}
                  className="mt-3 px-4 py-2 text-xs font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors"
                >
                  Save Request
                </button>
              </div>
            ) : (
              /* AI conversation */
              <div className="space-y-3 mb-4">
                {refineMessages.length === 0 && (
                  <p className="text-xs text-gray-400">Describe what you'd like changed or added. The AI will ask clarifying questions to create a clear request.</p>
                )}
                {refineMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] px-3 py-2 rounded-xl text-sm leading-relaxed ${
                      msg.role === 'user' ? 'bg-blue-600 text-white rounded-br-md' : 'bg-gray-100 text-gray-800 rounded-bl-md'
                    }`}>
                      {msg.content.replace(/===TITLE===[\s\S]*$/, '').trim() || msg.content}
                    </div>
                  </div>
                ))}
                {refineLoading && (
                  <div className="flex justify-start">
                    <div className="bg-gray-100 text-gray-500 px-3 py-2 rounded-xl rounded-bl-md text-sm animate-pulse">Thinking...</div>
                  </div>
                )}
                <div ref={refineEndRef} />
              </div>
            )}

            {!refineDone && (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={refineInput}
                  onChange={(e) => setRefineInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleRefineSubmit(); }}
                  placeholder={refineMessages.length === 0 ? 'What would you like changed or added?' : 'Answer the question...'}
                  disabled={refineLoading}
                  className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                  autoFocus
                />
                <button
                  onClick={handleRefineSubmit}
                  disabled={refineLoading || !refineInput.trim()}
                  className="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  Send
                </button>
              </div>
            )}
          </div>
        ) : (
          /* ── Request List ── */
          <div className="max-w-2xl mx-auto space-y-3">
            {(tab === 'upcoming' ? pending : done).length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-8">
                {tab === 'upcoming' ? 'No pending requests. Click "+ New Request" to add one.' : 'No completed requests yet.'}
              </p>
            ) : (
              (tab === 'upcoming' ? pending : done).map(req => (
                <div key={req.id} className="group border border-gray-200 rounded-xl p-4 bg-white hover:shadow-sm transition-shadow">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-semibold text-gray-900">{req.title}</h4>
                      <p className="text-xs text-gray-600 mt-1 leading-relaxed">{req.description}</p>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-[10px] text-gray-400">
                          {req.source === 'chat' ? 'From chat' : 'Manual'} · v{req.app_version}
                        </span>
                        <span className="text-[10px] text-gray-400">
                          {new Date(req.created_at).toLocaleDateString()}
                        </span>
                        {req.completed_at && (
                          <span className="text-[10px] text-green-600">
                            Completed {new Date(req.completed_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {req.status === 'pending' && (
                        <button
                          onClick={() => { setCompleteId(req.id); setPassword(''); setCompleteError(''); }}
                          className="text-xs px-2 py-1 text-green-700 bg-green-50 rounded-lg hover:bg-green-100 font-medium transition-colors"
                        >
                          Complete
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(req.id)}
                        className="opacity-0 group-hover:opacity-100 p-1 text-gray-300 hover:text-red-500 transition-all"
                        title="Delete"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m-7 0a1 1 0 01-1-1V5a1 1 0 011-1h6a1 1 0 011 1v1a1 1 0 01-1 1H9z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Complete password modal */}
      {completeId != null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setCompleteId(null)}>
          <div className="bg-white rounded-xl shadow-xl p-5 w-80" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Mark as Complete</h3>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleComplete(); }}
              placeholder="Enter password"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500 mb-2"
              autoFocus
            />
            {completeError && <p className="text-xs text-red-500 mb-2">{completeError}</p>}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setCompleteId(null)} className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700">Cancel</button>
              <button onClick={handleComplete} className="px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded-lg hover:bg-green-700">Complete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
