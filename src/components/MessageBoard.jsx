import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Hash, Plus, Users } from 'lucide-react';

const POLL_MS = 2500; // how often we check for new messages (live feel, no websockets)

// ── link pasting ─────────────────────────────────────────────────────────────
// Turns any http(s):// or www. links in a message into clickable links.
const LINK_RE = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;

function LinkifiedText({ text }) {
  const parts = text.split(LINK_RE);
  return parts.map((part, i) => {
    if (/^(?:https?:\/\/|www\.)/i.test(part)) {
      // don't swallow trailing punctuation like "check it out: https://x.com."
      const clean = part.replace(/[),.;:!?]+$/, '');
      const tail  = part.slice(clean.length);
      const href  = /^www\./i.test(clean) ? `https://${clean}` : clean;
      return (
        <span key={i}>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline break-all"
            style={{ color: '#5aa9e6' }}
          >
            {clean}
          </a>
          {tail}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export default function MessageBoard({ session }) {
  const [channels, setChannels]     = useState([]);
  const [activeId, setActiveId]     = useState(null);
  const [messages, setMessages]     = useState([]);
  const [input, setInput]           = useState('');
  const [live, setLive]             = useState(false);
  const [memberCount, setMemberCount] = useState(0);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [sending, setSending]       = useState(false);

  const lastIdRef    = useRef(0);
  const endRef       = useRef(null);
  const inputRef     = useRef(null);
  const token        = session.token;

  // Authenticated fetch helper
  const api = useCallback((path, opts = {}) => fetch(path, {
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  }), [token]);

  const activeChannel = channels.find(c => c.id === activeId) || null;

  // ── load channels (+ slow refresh so channels others create show up) ──
  useEffect(() => {
    let cancelled = false;
    const loadChannels = async () => {
      try {
        const res = await api('/api/channels');
        if (!res.ok) return;
        const list = await res.json();
        if (cancelled) return;
        setChannels(list);
        setActiveId(prev => prev ?? list[0]?.id ?? null);
      } catch { /* ignore */ }
    };
    loadChannels();
    const t = setInterval(loadChannels, 20000);
    return () => { cancelled = true; clearInterval(t); };
  }, [api]);

  // ── member count ────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/users/count')
      .then(r => r.json())
      .then(d => setMemberCount(d.count || 0))
      .catch(() => {});
  }, []);

  // ── load history when switching channels ───────────────────────────────
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setMessages([]);
    lastIdRef.current = 0;
    setLive(false);

    (async () => {
      try {
        const res = await api(`/api/channels/${activeId}/messages?limit=100`);
        if (!res.ok || cancelled) return;
        const list = await res.json();
        if (cancelled) return;
        setMessages(list);
        lastIdRef.current = list.length ? list[list.length - 1].id : 0;
        setLive(true);
      } catch { /* ignore */ }
    })();

    return () => { cancelled = true; };
  }, [activeId, api]);

  // ── poll for new messages ───────────────────────────────────────────────
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await api(`/api/channels/${activeId}/messages?after=${lastIdRef.current}`);
        if (cancelled) return;
        setLive(res.ok);
        if (!res.ok) return;
        const fresh = await res.json();
        if (cancelled || fresh.length === 0) return;
        lastIdRef.current = fresh[fresh.length - 1].id;
        setMessages(prev => {
          const known = new Set(prev.map(m => m.id));
          const additions = fresh.filter(m => !known.has(m.id));
          return additions.length ? [...prev, ...additions] : prev;
        });
      } catch { if (!cancelled) setLive(false); }
    };

    const t = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [activeId, api]);

  // ── autoscroll + focus ──────────────────────────────────────────────────
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { inputRef.current?.focus(); }, [activeId]);

  // ── send ────────────────────────────────────────────────────────────────
  const handleSend = useCallback(async (e) => {
    e.preventDefault();
    const body = input.trim();
    if (!body || !activeId || sending) return;
    setSending(true);
    try {
      const res = await api(`/api/channels/${activeId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      if (res.ok) {
        const msg = await res.json();
        setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
        lastIdRef.current = Math.max(lastIdRef.current, msg.id);
        setInput('');
      }
    } catch { /* keep text so user can retry */ }
    setSending(false);
    inputRef.current?.focus();
  }, [input, activeId, sending, api]);

  // ── create channel ──────────────────────────────────────────────────────
  const handleCreateChannel = async (e) => {
    e.preventDefault();
    const name = newChannelName.trim();
    if (!name) return;
    try {
      const res = await api('/api/channels', { method: 'POST', body: JSON.stringify({ name }) });
      const data = await res.json();
      if (res.ok) {
        setChannels(prev => [...prev, data]);
        setActiveId(data.id);
        setNewChannelName('');
        setShowNewChannel(false);
      } else {
        alert(data.error || 'Could not create channel');
      }
    } catch { /* ignore */ }
  };

  const avatarColor = (name) => {
    const colors = ['#0066B3', '#6366f1', '#8b5cf6', '#0891b2', '#059669', '#d97706'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return colors[Math.abs(h) % colors.length];
  };

  const formatTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const formatFull = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex" style={{ height: 'calc(100vh - 48px)', background: 'var(--bg-base)' }}>

      {/* ── Channel sidebar ── */}
      <aside className="w-52 shrink-0 flex flex-col"
             style={{ borderRight: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>
        <div className="px-3 pt-3 pb-2 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-widest" style={{ color: 'var(--text-subtle)' }}>
            Channels
          </span>
          <button
            onClick={() => setShowNewChannel(s => !s)}
            title="New channel"
            className="p-1 rounded transition-colors"
            style={{ color: 'var(--text-subtle)' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-subtle)'}>
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {channels.map(ch => {
            const active = ch.id === activeId;
            return (
              <button
                key={ch.id}
                onClick={() => setActiveId(ch.id)}
                title={ch.description || `#${ch.name}`}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-sm text-left transition-colors"
                style={{
                  background: active ? 'var(--bg-overlay)' : 'transparent',
                  color:      active ? 'var(--text-primary)' : 'var(--text-muted)',
                  border:     active ? '1px solid var(--border)' : '1px solid transparent',
                }}>
                <Hash className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-subtle)' }} />
                <span className="truncate">{ch.name}</span>
              </button>
            );
          })}
          {channels.length === 0 && (
            <p className="px-2 py-4 text-xs" style={{ color: 'var(--text-subtle)' }}>No channels yet</p>
          )}
        </div>

        {/* New channel form */}
        {showNewChannel && (
          <form onSubmit={handleCreateChannel} className="p-2" style={{ borderTop: '1px solid var(--border)' }}>
            <input
              autoFocus
              type="text"
              value={newChannelName}
              onChange={e => setNewChannelName(e.target.value)}
              placeholder="new-channel-name"
              maxLength={32}
              className="w-full px-2 py-1.5 rounded text-xs outline-none"
              style={{
                background: 'var(--bg-overlay)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
              }}
            />
            <div className="flex gap-1 mt-1.5">
              <button type="submit"
                className="flex-1 py-1 rounded text-xs font-medium"
                style={{ background: 'var(--accent)', color: '#fff' }}>
                Create
              </button>
              <button type="button" onClick={() => setShowNewChannel(false)}
                className="px-2 py-1 rounded text-xs"
                style={{ border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </aside>

      {/* ── Main column ── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Channel header */}
        <div className="px-5 h-11 flex items-center justify-between shrink-0"
             style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <Hash className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-subtle)' }} />
            <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
              {activeChannel?.name || '…'}
            </span>
            {activeChannel?.description && (
              <span className="text-xs truncate hidden sm:inline" style={{ color: 'var(--text-subtle)' }}>
                — {activeChannel.description}
              </span>
            )}
            <span className="text-xs px-1.5 py-0.5 rounded shrink-0" style={{
              background: live ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
              color:      live ? '#22c55e'              : '#ef4444',
              border:     `1px solid ${live ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
            }}>
              {live ? 'live' : 'offline'}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Users className="w-3.5 h-3.5" style={{ color: 'var(--text-subtle)' }} />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{memberCount}</span>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm" style={{ color: 'var(--text-subtle)' }}>
                {live ? `No messages in #${activeChannel?.name || '…'} yet. Say hi!` : 'Loading…'}
              </p>
            </div>
          )}

          {messages.map((msg, i) => {
            const prev    = messages[i - 1];
            const grouped = prev?.userId === msg.userId && (msg.ts - prev.ts) < 5 * 60 * 1000;
            const isOwn   = msg.userId === session.userId;

            return (
              <div key={msg.id} className={`flex gap-3 ${grouped ? 'mt-0.5' : 'mt-4'}`}>
                {/* Avatar */}
                <div className="w-7 h-7 shrink-0 mt-0.5">
                  {!grouped && (
                    <div className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-semibold text-white select-none"
                         style={{ background: avatarColor(msg.username) }}>
                      {msg.username.charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  {!grouped && (
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-sm font-medium"
                            style={{ color: isOwn ? 'var(--accent)' : 'var(--text-primary)' }}>
                        {msg.username}
                      </span>
                      {msg.verified && (
                        <span className="text-xs px-1 py-0.5 rounded"
                              style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e',
                                       border: '1px solid rgba(34,197,94,0.2)', lineHeight: 1 }}>
                          ✓
                        </span>
                      )}
                      <span className="text-xs" style={{ color: 'var(--text-subtle)' }} title={formatFull(msg.ts)}>
                        {formatTime(msg.ts)}
                      </span>
                    </div>
                  )}
                  <p className="text-sm leading-relaxed break-words whitespace-pre-wrap"
                     style={{ color: 'var(--text-muted)' }}>
                    <LinkifiedText text={msg.body} />
                  </p>
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>

        {/* Input */}
        <div className="px-5 py-3 shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
          <form onSubmit={handleSend} className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              maxLength={2000}
              placeholder={`Message #${activeChannel?.name || '…'} — paste links and they'll be clickable`}
              className="flex-1 rounded-lg px-4 py-2.5 text-sm outline-none transition-colors"
              style={{
                background: 'var(--bg-elevated)',
                border:     '1px solid var(--border)',
                color:      'var(--text-primary)',
              }}
              onFocus={e => e.target.style.borderColor = 'var(--border-light)'}
              onBlur={e  => e.target.style.borderColor = 'var(--border)'}
            />
            <button type="submit" disabled={!input.trim() || sending}
              className="px-4 py-2.5 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-all duration-150"
              style={{
                background: input.trim() && !sending ? 'var(--accent)' : 'var(--bg-overlay)',
                color:      input.trim() && !sending ? '#fff'          : 'var(--text-subtle)',
                cursor:     input.trim() && !sending ? 'pointer'       : 'not-allowed',
              }}>
              <Send className="w-3.5 h-3.5" />
              Send
            </button>
          </form>
          <p className="mt-1.5 text-xs" style={{ color: 'var(--text-subtle)' }}>
            Signed in as <span style={{ color: 'var(--text-muted)' }}>{session.username}</span>
            {session.verified && (
              <span className="ml-1" style={{ color: '#22c55e' }}>✓ verified</span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
