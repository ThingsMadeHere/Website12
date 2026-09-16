import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Hash, Plus, Users, Menu, X, Trash2, Ban, Bell, BellOff, Settings } from 'lucide-react';
import TagPill from './TagPill';
import NotificationSettings from './NotificationSettings';

const POLL_MS = 2500; // how often we check for new messages (live feel, no websockets)
const NOTIFICATION_SETTINGS_KEY = 'mchs_notification_settings';

// ── member photos ────────────────────────────────────────────────────────────
// Authenticated fetch, cached per member for the lifetime of the page.
const photoCache = new Map();
function fetchUserPhoto(userId, token) {
  if (!photoCache.has(userId)) {
    photoCache.set(
      userId,
      fetch(`/api/users/${userId}/photo`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => (r.ok ? r.blob() : null))
        .then(b => {
          const url = b ? URL.createObjectURL(b) : null;
          if (!url) photoCache.delete(userId); // allow a retry once a photo exists
          return url;
        })
        .catch(() => { photoCache.delete(userId); return null; })
    );
  }
  return photoCache.get(userId);
}

const avatarColor = (name) => {
  const colors = ['#15803d', '#a67c00', '#4d7c0f', '#0f766e', '#92400e', '#3f6212'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
};

function UserAvatar({ msg, token }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!msg.hasPhoto) return undefined; // keyed remount clears a removed photo
    let cancelled = false;
    fetchUserPhoto(msg.userId, token).then(u => { if (!cancelled && u) setUrl(u); });
    return () => { cancelled = true; };
  }, [msg.userId, msg.hasPhoto, token]);

  if (url)
    return <img src={url} alt="" className="w-7 h-7 rounded-md object-cover"
                style={{ border: '1px solid var(--border)' }} />;
  return (
    <div className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-semibold text-white select-none"
         style={{ background: avatarColor(msg.username) }}>
      {msg.username.charAt(0).toUpperCase()}
    </div>
  );
}

// ── link pasting ─────────────────────────────────────────────────────────────
// Turns any http(s):// or www. links in a message into clickable links.
const LINK_RE = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;

// Direct image URLs also render as inline embeds
const IMG_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp)(?:[?#][^\s<>"']*)?$/i;

// don't swallow trailing punctuation like "check it out: https://x.com."
function cleanLink(part) {
  const clean = part.replace(/[),.;:!?]+$/, '');
  return { clean, tail: part.slice(clean.length) };
}

function toHref(clean) {
  return /^www\./i.test(clean) ? `https://${clean}` : clean;
}

function LinkifiedText({ text }) {
  const parts = text.split(LINK_RE);
  return parts.map((part, i) => {
    if (/^(?:https?:\/\/|www\.)/i.test(part)) {
      const { clean, tail } = cleanLink(part);
      const href = toHref(clean);
      return (
        <span key={i}>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline break-all"
            style={{ color: '#a16207' }}
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

// Pulls direct image links out of a message body (max 4 embeds per message)
function extractImageLinks(text) {
  const found = text.match(LINK_RE) || [];
  const seen = new Set();
  const imgs = [];
  for (const raw of found) {
    const { clean } = cleanLink(raw);
    const href = toHref(clean);
    if (IMG_EXT_RE.test(href) && !seen.has(href)) {
      seen.add(href);
      imgs.push(href);
    }
  }
  return imgs.slice(0, 4);
}

function ImageEmbed({ src }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null; // broken/non-image URL — just keep the text link
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="block max-w-full">
      <img
        src={src}
        alt="Shared image"
        loading="lazy"
        onError={() => setFailed(true)}
        className="block rounded-lg max-h-64 sm:max-h-80"
        style={{ border: '1px solid var(--border)', maxWidth: 'min(100%, 22rem)' }}
      />
    </a>
  );
}

function ImageEmbeds({ text }) {
  const urls = extractImageLinks(text);
  if (urls.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1.5">
      {urls.map(src => <ImageEmbed key={src} src={src} />)}
    </div>
  );
}

export default function MessageBoard({ session, refreshSession }) {
  const [channels, setChannels]     = useState([]);
  const [activeId, setActiveId]     = useState(null);
  const [messages, setMessages]     = useState([]);
  const [input, setInput]           = useState('');
  const [live, setLive]             = useState(false);
  const [memberCount, setMemberCount] = useState(0);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [sending, setSending]       = useState(false);
  const [sendError, setSendError]   = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile channel drawer
  const [now, setNow]               = useState(Date.now());
  const [notificationEnabled, setNotificationEnabled] = useState(false);
  const [notificationSettings, setNotificationSettings] = useState('all'); // 'all' | 'mentions_only' | 'none'
  const [showSettings, setShowSettings] = useState(false);
  const [isPageVisible, setIsPageVisible] = useState(true);

  const lastIdRef    = useRef(0);
  const lastDelIdRef = useRef(0); // deletion-tombstone cursor
  const endRef       = useRef(null);
  const inputRef     = useRef(null);
  const token        = session.token;
  const previousMessageCountRef = useRef(0);

  // Timeout state — the server blocks writes; this shows the member why.
  const timeoutUntil = session.timeoutUntil ? new Date(session.timeoutUntil) : null;
  const isTimedOut   = !!(timeoutUntil && !isNaN(timeoutUntil) && timeoutUntil.getTime() > now);

  // tick so the timeout banner appears/clears without a reload
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // Load notification settings from server
  useEffect(() => {
    const loadNotificationSettings = async () => {
      try {
        const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const me = await res.json();
          setNotificationSettings(me.notificationSettings || 'all');
          setNotificationEnabled(me.notificationSettings !== 'none');
        }
      } catch { /* ignore */ }
    };
    loadNotificationSettings();
  }, [token]);

  // Save notification settings to server
  const saveNotificationSettings = useCallback(async (settings) => {
    try {
      const res = await fetch('/api/me/notification-settings', {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ settings })
      });
      if (res.ok) {
        setNotificationSettings(settings);
        setNotificationEnabled(settings !== 'none');
      }
    } catch { /* ignore */ }
  }, [token]);


  // Toggle notifications - open settings modal
  const toggleNotifications = useCallback(() => {
    setShowSettings(true);
  }, []);

  // Browser visibility detection
  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsPageVisible(!document.hidden);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

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
    lastDelIdRef.current = 0;
    setLive(false);

    (async () => {
      try {
        const res = await api(`/api/channels/${activeId}/messages?limit=100`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        const list = data.messages || [];
        setMessages(list);
        lastIdRef.current = list.length ? list[list.length - 1].id : 0;
        lastDelIdRef.current = data.lastDeletionId || 0;
        setLive(true);
      } catch { /* ignore */ }
    })();

    return () => { cancelled = true; };
  }, [activeId, api]);

  // ── poll for new messages + deletions ──────────────────────────────────
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await api(
          `/api/channels/${activeId}/messages?after=${lastIdRef.current}&afterDel=${lastDelIdRef.current}`
        );
        if (cancelled) return;
        setLive(res.ok);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;

        const fresh = data.messages || [];
        const dels  = data.deletions || [];
        if (typeof data.lastDeletionId === 'number') lastDelIdRef.current = data.lastDeletionId;
        if (fresh.length) lastIdRef.current = fresh[fresh.length - 1].id;
        if (fresh.length === 0 && dels.length === 0) return;

        setMessages(prev => {
          // remove anything deleted since our last check (by us or by an admin)
          const delIds = new Set(dels.map(d => d.messageId));
          const kept = delIds.size ? prev.filter(m => !delIds.has(m.id)) : prev;
          const known = new Set(kept.map(m => m.id));
          const additions = fresh.filter(m => !known.has(m.id));
          return (additions.length || delIds.size) ? [...kept, ...additions] : prev;
        });

        // Browser notifications are now handled by push notifications
        // via the service worker, so we don't need to show them here
      } catch { if (!cancelled) setLive(false); }
    };

    const t = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [activeId, api, notificationEnabled, isPageVisible, channels, session.userId]);

  // ── autoscroll + focus ──────────────────────────────────────────────────
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => {
    // Only auto-focus on devices with a real keyboard — on phones this would
    // pop the on-screen keyboard the moment the board opens.
    if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
      inputRef.current?.focus();
    }
  }, [activeId]);

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
        setSendError('');
        const msg = await res.json();
        setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
        lastIdRef.current = Math.max(lastIdRef.current, msg.id);
        setInput('');
      } else {
        const data = await res.json().catch(() => ({}));
        setSendError(data.error || 'Could not send message');
        if (data.code === 'timeout') refreshSession?.(); // sync the banner immediately
      }
    } catch { setSendError('Could not reach server — message not sent'); }
    setSending(false);
    inputRef.current?.focus();
  }, [input, activeId, sending, api, refreshSession]);

  // ── delete (own messages, or any message for admins) ───────────────────
  const canDelete = useCallback(
    (msg) => msg.userId === session.userId || !!session.admin,
    [session.userId, session.admin]
  );

  const handleDelete = useCallback(async (msg) => {
    const isOwn = msg.userId === session.userId;
    const prompt = isOwn
      ? 'Delete your message?'
      : `Delete ${msg.username}'s message? (admin)`;
    if (!window.confirm(prompt)) return;
    try {
      const res = await api(`/api/messages/${msg.id}`, { method: 'DELETE' });
      if (res.ok) {
        setMessages(prev => prev.filter(m => m.id !== msg.id));
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Could not delete message');
      }
    } catch { /* ignore */ }
  }, [api, session.userId]);

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
        setSidebarOpen(false);
      } else {
        alert(data.error || 'Could not create channel');
      }
    } catch { /* ignore */ }
  };

  // ── delete channel (admin only) ─────────────────────────────────────────
  const handleDeleteChannel = async (channelId, channelName) => {
    if (!session.admin) {
      alert('Only admins can delete channels');
      return;
    }
    if (!window.confirm(`Delete channel #${channelName}? This action cannot be undone.`)) return;
    try {
      const res = await api(`/api/channels/${channelId}`, { method: 'DELETE' });
      if (res.ok) {
        setChannels(prev => prev.filter(c => c.id !== channelId));
        if (activeId === channelId) {
          setActiveId(channels.find(c => c.id !== channelId)?.id || null);
        }
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Could not delete channel');
      }
    } catch { /* ignore */ }
  };

  const formatTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const formatFull = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex board-shell" style={{ background: 'var(--bg-base)' }}>

      {/* Mobile drawer backdrop */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 md:hidden" style={{ background: 'rgba(0,0,0,0.6)' }}
             onClick={() => setSidebarOpen(false)} />
      )}

      {/* ── Channel sidebar (off-canvas drawer on mobile) ── */}
      <aside
        className={[
          'fixed top-12 bottom-0 left-0 z-40 w-60 flex flex-col',
          'transform transition-transform duration-200 ease-out',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          'md:static md:top-auto md:bottom-auto md:z-auto md:w-52 md:shrink-0 md:translate-x-0',
        ].join(' ')}
        style={{ borderRight: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>
        <div className="px-3 pt-3 pb-2 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-widest" style={{ color: 'var(--text-subtle)' }}>
            Channels
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowNewChannel(s => !s)}
              title="New channel"
              className="p-1 rounded transition-colors"
              style={{ color: 'var(--text-subtle)' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-subtle)'}>
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setSidebarOpen(false)}
              title="Close channels"
              className="p-1 rounded transition-colors md:hidden"
              style={{ color: 'var(--text-subtle)' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-subtle)'}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {channels.map(ch => {
            const active = ch.id === activeId;
            return (
              <div key={ch.id} className="flex items-center gap-1 group">
                <button
                  onClick={() => { setActiveId(ch.id); setSidebarOpen(false); }}
                  title={ch.description || `#${ch.name}`}
                  className="flex-1 flex items-center gap-1.5 px-2 py-2 md:py-1.5 rounded text-sm text-left transition-colors"
                  style={{
                    background: active ? 'var(--bg-overlay)' : 'transparent',
                    color:      active ? 'var(--text-primary)' : 'var(--text-muted)',
                    border:     active ? '1px solid var(--border)' : '1px solid transparent',
                  }}>
                  <Hash className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-subtle)' }} />
                  <span className="truncate">{ch.name}</span>
                </button>
                {session.admin && (
                  <button
                    onClick={() => handleDeleteChannel(ch.id, ch.name)}
                    title="Delete channel (admin)"
                    className="p-1 rounded transition-colors opacity-0 group-hover:opacity-100"
                    style={{ color: 'var(--text-subtle)' }}
                    onMouseEnter={e => e.currentTarget.style.color = '#dc2626'}
                    onMouseLeave={e => e.currentTarget.style.color = 'var(--text-subtle)'}>
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
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
        <div className="px-3 sm:px-5 h-11 flex items-center justify-between shrink-0 gap-2"
             style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              title="Channels"
              className="md:hidden p-1.5 -ml-1.5 rounded transition-colors shrink-0"
              style={{ color: 'var(--text-muted)' }}>
              <Menu className="w-4 h-4" />
            </button>
            <Hash className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-subtle)' }} />
            <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
              {activeChannel?.name || '…'}
            </span>
            {activeChannel?.description && (
              <span className="text-xs truncate hidden lg:inline" style={{ color: 'var(--text-subtle)' }}>
                — {activeChannel.description}
              </span>
            )}
            <span className="text-xs px-1.5 py-0.5 rounded shrink-0 hidden sm:inline" style={{
              background: live ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
              color:      live ? '#166534'              : '#dc2626',
              border:     `1px solid ${live ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
            }}>
              {live ? 'live' : 'offline'}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={toggleNotifications}
              title="Notification settings"
              className="p-1.5 rounded transition-colors"
              style={{ color: notificationEnabled ? 'var(--accent)' : 'var(--text-subtle)' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = notificationEnabled ? 'var(--accent)' : 'var(--text-subtle)'}>
              {notificationEnabled ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
            </button>
            <Users className="w-3.5 h-3.5" style={{ color: 'var(--text-subtle)' }} />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{memberCount}</span>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-3 sm:py-4">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-center px-4" style={{ color: 'var(--text-subtle)' }}>
                {live ? `No messages in #${activeChannel?.name || '…'} yet. Say hi!` : 'Loading…'}
              </p>
            </div>
          )}

          {messages.map((msg, i) => {
            const prev    = messages[i - 1];
            const grouped = prev?.userId === msg.userId && (msg.ts - prev.ts) < 5 * 60 * 1000;
            const isOwn   = msg.userId === session.userId;

            return (
              <div key={msg.id} className={`msg-row flex gap-2 sm:gap-3 ${grouped ? 'mt-0.5' : 'mt-4'}`}>
                {/* Avatar */}
                <div className="w-7 h-7 shrink-0 mt-0.5">
                  {!grouped && <UserAvatar key={`${msg.userId}:${msg.hasPhoto ? 1 : 0}`} msg={msg} token={token} />}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  {!grouped && (
                    <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                      <span className="text-sm font-medium"
                            style={{ color: isOwn ? 'var(--accent)' : 'var(--text-primary)' }}>
                        {msg.username}
                      </span>
                      {msg.admin && (
                        <span className="text-xs px-1 py-0.5 rounded"
                              style={{ background: 'rgba(255,199,44,0.12)', color: '#a16207',
                                       border: '1px solid rgba(255,199,44,0.32)', lineHeight: 1 }}>
                          ADMIN
                        </span>
                      )}
                      {msg.verified && (
                        <span className="text-xs px-1 py-0.5 rounded"
                              style={{ background: 'rgba(34,197,94,0.1)', color: '#166534',
                                       border: '1px solid rgba(34,197,94,0.2)', lineHeight: 1 }}>
                          ✓
                        </span>
                      )}
                      {(msg.tags || []).filter(t => t !== 'admin').map(t => <TagPill key={t} tag={t} xs />)}
                      <span className="text-xs" style={{ color: 'var(--text-subtle)' }} title={formatFull(msg.ts)}>
                        {formatTime(msg.ts)}
                      </span>
                    </div>
                  )}
                  <p className="text-sm leading-relaxed break-words whitespace-pre-wrap"
                     style={{ color: 'var(--text-muted)' }}>
                    <LinkifiedText text={msg.body} />
                  </p>
                  {/* Inline image embeds for direct image links */}
                  <ImageEmbeds text={msg.body} />
                </div>

                {/* Delete — own messages, or any message for admins */}
                {canDelete(msg) && (
                  <button
                    onClick={() => handleDelete(msg)}
                    title={isOwn ? 'Delete message' : 'Delete message (admin)'}
                    className="msg-actions shrink-0 self-start mt-0.5 p-1.5 rounded transition-colors"
                    style={{ color: 'var(--text-subtle)' }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#dc2626'; e.currentTarget.style.background = 'rgba(239,68,68,0.08)'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-subtle)'; e.currentTarget.style.background = 'transparent'; }}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
          <div ref={endRef} />
        </div>

        {/* Input — replaced by a notice while the member is timed out */}
        {isTimedOut ? (
          <div className="px-3 py-2.5 sm:px-5 sm:py-3 shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
            <div className="rounded-lg p-3 flex items-start gap-2.5"
                 style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)' }}>
              <Ban className="w-4 h-4 mt-0.5 shrink-0" style={{ color: '#dc2626' }} />
              <div className="min-w-0">
                <p className="text-xs font-medium" style={{ color: '#dc2626' }}>You are timed out</p>
                <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  You can read the board, but posting is disabled until{' '}
                  {timeoutUntil.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.
                  Talk to an admin if you think this is a mistake.
                </p>
              </div>
            </div>
          </div>
        ) : (
        <div className="px-3 py-2.5 sm:px-5 sm:py-3 shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
          <form onSubmit={handleSend} className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              maxLength={2000}
              placeholder={`Message #${activeChannel?.name || '…'}`}
              className="flex-1 min-w-0 rounded-lg px-3 sm:px-4 py-2.5 text-sm outline-none transition-colors"
              style={{
                background: 'var(--bg-elevated)',
                border:     `1px solid ${sendError ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`,
                color:      'var(--text-primary)',
              }}
              onFocus={e => e.target.style.borderColor = sendError ? 'rgba(239,68,68,0.4)' : 'var(--border-light)'}
              onBlur={e  => e.target.style.borderColor = sendError ? 'rgba(239,68,68,0.4)' : 'var(--border)'}
            />
            <button type="submit" disabled={!input.trim() || sending}
              className="px-3 sm:px-4 py-2.5 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-all duration-150 shrink-0"
              style={{
                background: input.trim() && !sending ? 'var(--accent)' : 'var(--bg-overlay)',
                color:      input.trim() && !sending ? '#fff'          : 'var(--text-subtle)',
                cursor:     input.trim() && !sending ? 'pointer'       : 'not-allowed',
              }}>
              <Send className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Send</span>
            </button>
          </form>
          {sendError && (
            <p className="mt-1.5 text-xs flex items-center gap-1.5" style={{ color: '#dc2626' }}>
              <Ban className="w-3 h-3 shrink-0" /> {sendError}
            </p>
          )}
          <p className="mt-1.5 text-xs hidden sm:block" style={{ color: 'var(--text-subtle)' }}>
            Signed in as <span style={{ color: 'var(--text-muted)' }}>{session.username}</span>
            {session.verified && (
              <span className="ml-1" style={{ color: '#166534' }}>✓ verified</span>
            )}
            {session.admin && (
              <span className="ml-1" style={{ color: '#a16207' }}>· admin</span>
            )}
            {(session.tags || []).filter(t => t !== 'admin').length > 0 && (
              <span className="ml-1" style={{ color: 'var(--text-subtle)' }}>
                · {(session.tags || []).filter(t => t !== 'admin').join(' · ')}
              </span>
            )}
          </p>
        </div>
        )}
      </div>

      {/* Notification Settings Modal */}
      {showSettings && (
        <NotificationSettings
          settings={notificationSettings}
          onChange={saveNotificationSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
