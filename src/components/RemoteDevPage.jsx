import { useState, useEffect, useRef, useCallback } from 'react';
import { FolderOpen, FileCode, Save, Play, Download, RefreshCw, AlertCircle, CheckCircle, Loader2, Terminal } from 'lucide-react';
import { apiFetch } from '../utils/api';

// Remote development workspace — a browser-only IDE for FRC code.
// Everything is plain HTTPS to our own API (no SSH client / terminal emulator /
// extensions), which is what locked-down school Chromebooks can actually run:
//   edit files → queue a build in the isolated compiler container →
//   watch the log stream back → download the artifact (robot flashing stays
//   admin-gated at POST /api/robot/deploy).
const API = '/api/remote-dev';

export default function RemoteDevPage({ session }) {
  const [connected, setConnected] = useState(false);
  const [entries, setEntries] = useState([]);        // flat list of visible rows
  const [expanded, setExpanded] = useState(() => new Set(['']));
  const [currentFile, setCurrentFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saveState, setSaveState] = useState(null);  // null | 'saved'
  const [job, setJob] = useState(null);              // { jobId, status, log, error, target }
  const pollRef = useRef(null);
  const token = session?.token;

  const loadDir = useCallback(async (dir) => {
    const data = await apiFetch(`${API}/files?path=${encodeURIComponent(dir)}`, { token });
    return data.files || [];
  }, [token]);

  const refreshTree = useCallback(async () => {
    try {
      const cache = {};
      const visible = [];
      const walk = async (dir, depth) => {
        const items = await loadDir(dir).catch(() => []);
        cache[dir] = items;
        for (const it of items) {
          visible.push({ ...it, depth });
          if (it.type === 'folder' && expanded.has(it.path)) await walk(it.path, depth + 1);
        }
      };
      await walk('', 0);
      setEntries(visible);
    } catch (err) {
      setError(err.message);
    }
  }, [expanded, loadDir]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      try {
        await apiFetch(`${API}/connect`, { token });
        if (!cancelled) setConnected(true);
      } catch (err) {
        if (!cancelled) { setError(err.message); setConnected(false); }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => { if (connected) refreshTree(); }, [connected, refreshTree]);

  // Stop polling when leaving the page.
  useEffect(() => () => clearInterval(pollRef.current), []);

  function toggleFolder(path) {
    setError(null);
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path); else n.add(path);
      return n;
    });
  }

  async function openFile(path) {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setError(null);
    try {
      const data = await apiFetch(`${API}/file?path=${encodeURIComponent(path)}`, { token });
      setCurrentFile(data.path);
      setFileContent(data.content ?? '');
      setDirty(false);
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveFile() {
    if (!currentFile) return;
    setIsLoading(true);
    try {
      await apiFetch(`${API}/file`, { method: 'PUT', token, body: { path: currentFile, content: fileContent } });
      setDirty(false);
      setSaveState('saved');
      setTimeout(() => setSaveState(null), 1500);
      refreshTree();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }

  // Ctrl/Cmd+S save shortcut.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function createEntry(type) {
    const name = window.prompt(`New ${type} name:`);
    if (!name) return;
    try {
      await apiFetch(`${API}/entry`, { method: 'POST', token, body: { dir: '', name, type } });
      refreshTree();
    } catch (err) { setError(err.message); }
  }

  async function deleteEntry(path, isFolder) {
    if (!window.confirm(`Delete ${isFolder ? 'folder' : 'file'} "${path}"${isFolder ? ' and everything inside it' : ''}?`)) return;
    try {
      await apiFetch(`${API}/entry`, { method: 'DELETE', token, body: { path } });
      if (currentFile === path) { setCurrentFile(null); setFileContent(''); setDirty(false); }
      refreshTree();
    } catch (err) { setError(err.message); }
  }

  function startCompile(target) {
    setError(null);
    apiFetch(`${API}/compile`, { method: 'POST', token, body: { target } })
      .then(({ jobId }) => {
        setJob({ jobId, status: 'queued', log: null, target });
        clearInterval(pollRef.current);
        let ticks = 0;
        pollRef.current = setInterval(async () => {
          ticks++;
          try {
            const s = await apiFetch(`${API}/compile/${jobId}/status`, { token });
            setJob(prev => prev ? { ...prev, ...s } : prev);
            if (['completed', 'failed', 'timeout'].includes(s.status)) clearInterval(pollRef.current);
            else if (ticks > 180) {
              clearInterval(pollRef.current);
              setJob(prev => prev ? { ...prev, status: 'timeout', error: 'Timed out waiting for the build' } : prev);
            }
          } catch (err) {
            clearInterval(pollRef.current);
            setJob(prev => prev ? { ...prev, status: 'failed', error: err.message } : prev);
          }
        }, 2000);
      })
      .catch(err => setError(err.message));
  }

  function downloadArtifact() {
    if (!job?.jobId) return;
    // Downloads need header auth, so fetch as a blob (supported by every
    // Chromebook browser) instead of navigating with a URL token.
    apiFetch(`${API}/compile/${job.jobId}/artifact`, { token, raw: true })
      .then(async res => {
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || 'Download failed');
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `deployment-${job.jobId}.tar.gz`;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      })
      .catch(err => setError(err.message));
  }

  const busy = job && ['queued', 'compiling'].includes(job.status);

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col" style={{ background: '#1f2937' }}>
      {/* Header */}
      <div style={{ borderBottom: '1px solid #374151', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#111827', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ color: '#fff', fontSize: 16, fontWeight: 600 }}>Remote Development Workspace</h2>
          <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 12, background: connected ? 'rgba(34,197,94,.2)' : 'rgba(239,68,68,.2)', color: connected ? '#22c55e' : '#ef4444', border: `1px solid ${connected ? 'rgba(34,197,94,.4)' : 'rgba(239,68,68,.4)'}` }}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={refreshTree} disabled={!connected || isLoading} style={btnStyle()}>
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button onClick={() => createEntry('file')} disabled={!connected} style={btnStyle()}>+ File</button>
          <button onClick={() => createEntry('folder')} disabled={!connected} style={btnStyle()}>+ Folder</button>
          <button onClick={() => startCompile('simulation')} disabled={!connected || !!busy} style={btnStyle(busy)}>
            <Play className="w-3.5 h-3.5" /> Build
          </button>
          {job?.status === 'completed' && (
            <button onClick={downloadArtifact} style={btnStyle()}>
              <Download className="w-3.5 h-3.5" /> Download jar
            </button>
          )}
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* File tree */}
        <div style={{ width: 280, borderRight: '1px solid #374151', background: '#111827', overflowY: 'auto', padding: 8 }}>
          <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, marginBottom: 8, padding: '4px 8px' }}>My workspace</div>
          {entries.length === 0 && <div style={{ color: '#6b7280', fontSize: 13, padding: '4px 8px' }}>No files yet — create one</div>}
          {entries.map(item => {
            const isFolder = item.type === 'folder';
            const isActive = currentFile === item.path;
            return (
              <div key={item.path} style={{ display: 'flex', alignItems: 'center' }}>
                <div
                  onClick={() => isFolder ? toggleFolder(item.path) : openFile(item.path)}
                  style={{ flex: 1, paddingLeft: item.depth * 14 + 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6, cursor: 'pointer', background: isActive ? 'rgba(20,83,45,.3)' : 'transparent', color: isActive ? '#fff' : '#d1d5db', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, overflow: 'hidden', whiteSpace: 'nowrap' }}
                >
                  <FolderOrFile isFolder={isFolder} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</span>
                </div>
                <button title="Delete" onClick={() => deleteEntry(item.path, isFolder)} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', padding: 4 }}>✕</button>
              </div>
            );
          })}
        </div>

        {/* Editor + build output */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {currentFile ? (
            <>
              <div style={{ borderBottom: '1px solid #374151', padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#111827' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                  <FileCode className="w-4 h-4 text-blue-400 shrink-0" />
                  <span style={{ color: '#fff', fontSize: 14 }}>{currentFile}{dirty ? ' •' : ''}</span>
                </div>
                <button onClick={saveFile} disabled={isLoading || !dirty} style={{ ...btnStyle(), opacity: dirty ? 1 : .5 }}>
                  <Save className="w-3.5 h-3.5" /> {saveState === 'saved' ? 'Saved!' : 'Save'} (Ctrl+S)
                </button>
              </div>
              <textarea
                value={fileContent}
                onChange={e => { setFileContent(e.target.value); setDirty(true); }}
                style={{ height: job ? '55%' : undefined, flex: job ? 'none' : 1, width: '100%', padding: 16, background: '#1f2937', color: '#e5e7eb', border: 'none', outline: 'none', resize: 'none', fontFamily: 'JetBrains Mono, Fira Code, monospace', fontSize: 14, lineHeight: 1.6 }}
                spellCheck={false}
              />
            </>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', flexDirection: 'column', gap: 12 }}>
              <FileCode className="w-16 h-16 opacity-20" />
              <p>Select a file to edit, or create a new one</p>
            </div>
          )}

          {/* Build output panel */}
          {job && (
            <div style={{ borderTop: '1px solid #374151', background: '#0b1220', height: '45%', minHeight: 140, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#9ca3af', borderBottom: '1px solid #1f2937' }}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin text-yellow-400" /> : job.status === 'completed' ? <CheckCircle className="w-4 h-4 text-green-400" /> : <AlertCircle className="w-4 h-4 text-red-400" />}
                <span>Build {job.jobId} — {job.status}{job.target ? ` (${job.target})` : ''}</span>
                <button onClick={() => { clearInterval(pollRef.current); setJob(null); }} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer' }}>Close</button>
              </div>
              <pre style={{ flex: 1, margin: 0, padding: 12, overflow: 'auto', color: '#a5f3fc', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
                {job.error || job.log || 'Waiting for compiler service…'}
              </pre>
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      {(error || saveState) && (
        <div style={{ borderTop: '1px solid #374151', padding: '8px 16px', background: '#111827', display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ef4444' }}>
              <AlertCircle className="w-4 h-4" /><span>{error}</span>
              <button onClick={() => setError(null)} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>✕</button>
            </div>
          )}
          {saveState === 'saved' && !error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#22c55e' }}>
              <Terminal className="w-4 h-4" /><span>File saved</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FolderOrFile({ isFolder }) {
  return isFolder
    ? <FolderOpen className="w-3.5 h-3.5 text-yellow-400" />
    : <FileCode className="w-3.5 h-3.5 text-blue-400" />;
}

function btnStyle(highlight) {
  return {
    padding: '6px 12px',
    background: highlight ? 'rgba(234,179,8,.8)' : 'rgba(20,83,45,.8)',
    color: '#fff',
    border: '1px solid rgba(34,197,94,.4)',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  };
}
