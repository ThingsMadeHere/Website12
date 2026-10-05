import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Zap, Settings, X, ChevronLeft, Hash } from 'lucide-react';
import io from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';

export default function DiscordChat({ session }) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [channels, setChannels] = useState([]);
  const [activeChannel, setActiveChannel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [socket, setSocket] = useState(null);
  const inputRef = useRef(null);
  const endRef = useRef(null);

  // Load channels on mount
  useEffect(() => {
    const loadChannels = async () => {
      try {
        const res = await fetch('/api/discord/channels');
        if (res.ok) {
          const data = await res.json();
          setChannels(data.channels || []);
          if (data.channels && data.channels.length > 0) {
            setActiveChannel(data.channels[0].id);
          }
        }
      } catch (err) {
        console.error('[Discord] Failed to load channels:', err);
      }
    };
    loadChannels();
  }, []);

  // Load messages for active channel
  useEffect(() => {
    if (!activeChannel) return;
    
    const loadHistory = async () => {
      try {
        const res = await fetch(`/api/discord/history?channelId=${activeChannel}&limit=50`);
        if (res.ok) {
          const data = await res.json();
          setMessages(data.messages || []);
        }
      } catch (err) {
        console.error('[Discord] Failed to load history:', err);
      } finally {
        setLoading(false);
      }
    };
    loadHistory();
  }, [activeChannel]);

  // Initialize Socket.IO connection
  useEffect(() => {
    if (!activeChannel) return;
    
    const newSocket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
    });

    newSocket.on('connect', () => {
      console.log('[Discord] Socket.IO connected');
    });

    newSocket.on('chat:message', (msg) => {
      if (msg.channelId === activeChannel || msg.channelId === undefined) {
        setMessages(prev => {
          // Avoid duplicates
          if (prev.some(m => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
        endRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    });

    newSocket.on('disconnect', () => {
      console.log('[Discord] Socket.IO disconnected');
    });

    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, [activeChannel]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (!loading) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, loading]);

  // Send message to Discord
  const handleSend = useCallback(async (e) => {
    e.preventDefault();
    const body = input.trim();
    if (!body || !session || !activeChannel) return;

    try {
      const res = await fetch('/api/discord/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: activeChannel,
          body,
          username: session.username,
          avatar: null,
          userId: session.userId,
        }),
      });
      if (res.ok) {
        setInput('');
        inputRef.current?.focus();
      }
    } catch (err) {
      console.error('[Discord] Failed to send:', err);
    }
  }, [input, session, activeChannel]);

  // Format timestamp
  const formatTime = (ts) => {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const activeChannelInfo = channels.find(c => c.id === activeChannel);

  return (
    <div className="flex board-shell" style={{ background: 'var(--bg-base)' }}>
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 md:hidden" style={{ background: 'rgba(0,0,0,0.6)' }}
             onClick={() => setSidebarOpen(false)} />
      )}

      {/* Channel Sidebar */}
      <aside
        className={[
          'fixed top-12 bottom-0 left-0 z-40 w-56 flex flex-col',
          'transform transition-transform duration-200 ease-out',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          'md:static md:top-auto md:bottom-auto md:z-auto md:w-52 md:shrink-0 md:translate-x-0',
        ].join(' ')}
        style={{ borderRight: '1px solid var(--border)', background: 'var(--bg-elevated)' }}
      >
        <div className="px-3 pt-3 pb-2 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-widest" style={{ color: 'var(--text-subtle)' }}>
            Discord
          </span>
          <button
            onClick={() => setSidebarOpen(false)}
            title="Close channels"
            className="p-1 rounded transition-colors md:hidden"
            style={{ color: 'var(--text-subtle)' }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {channels.map(ch => (
            <button
              key={ch.id}
              onClick={() => { setActiveChannel(ch.id); setSidebarOpen(false); }}
              className={`flex items-center gap-2 px-3 py-2 rounded text-sm text-left w-full ${
                activeChannel === ch.id 
                  ? 'bg-gray-800 text-white border border-gray-700' 
                  : 'text-gray-400 hover:bg-gray-800'
              }`}
            >
              <Hash className="w-4 h-4 text-gray-500" />
              <span className="truncate">{ch.name}</span>
            </button>
          ))}
          {channels.length === 0 && (
            <p className="px-3 py-4 text-xs text-gray-500">No channels loaded...</p>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="px-4 py-2 flex items-center justify-between shrink-0"
             style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-base)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              title="Channels"
              className="md:hidden p-1.5 -ml-1.5 rounded transition-colors shrink-0"
              style={{ color: 'var(--text-muted)' }}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <Zap className="w-4 h-4 shrink-0" style={{ color: '#5ee4ff' }} />
            <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
              {activeChannelInfo?.name || '...'}
            </span>
            {activeChannelInfo?.topic && (
              <span className="text-xs truncate hidden lg:inline" style={{ color: 'var(--text-subtle)' }}>
                — {activeChannelInfo.topic}
              </span>
            )}
          </div>

          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            className="p-1.5 rounded transition-colors"
            style={{ color: 'var(--text-subtle)' }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-subtle)' }}
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {loading && (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <div 
                  className="inline-block w-8 h-8 border-2 border-transparent border-t-white rounded-full animate-spin mb-3"
                  style={{ borderColor: 'rgba(255,255,255,0.3)', borderTopColor: '#ffffff' }}
                />
                <p className="text-white text-sm">Loading Discord messages...</p>
              </div>
            </div>
          )}

          {!loading && messages.length === 0 && (
            <div className="flex items-center justify-center h-64">
              <p className="text-sm text-center px-4" style={{ color: '#9ca3af' }}>
                No messages in #{activeChannelInfo?.name || '...'} yet. Say hello!
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className="flex gap-3">
              {/* Avatar */}
              <div className="w-10 h-10 shrink-0 rounded-full overflow-hidden border border-gray-700">
                {msg.avatar ? (
                  <img src={msg.avatar} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div 
                    className="w-full h-full flex items-center justify-center text-xs font-bold text-white"
                    style={{ background: '#10B981' }}
                  >
                    {msg.username?.charAt(0)?.toUpperCase() || '?'}
                  </div>
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 mb-1">
                  <span 
                    className="text-sm font-semibold"
                    style={{ color: msg.type === 'website' ? '#5ee4ff' : '#ffffff' }}
                  >
                    {msg.username}
                  </span>
                  <span className="text-xs" style={{ color: '#9ca3af' }}>
                    {msg.type === 'discord' ? 'Discord' : 'Website'}
                  </span>
                  <span className="text-xs" style={{ color: '#6b7280' }}>
                    {formatTime(msg.ts)}
                  </span>
                </div>
                <p 
                  className="text-sm whitespace-pre-wrap break-words"
                  style={{ color: '#d1d5db' }}
                >
                  {msg.body}
                </p>
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-3 shrink-0" style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>
          <form onSubmit={handleSend} className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Message #${activeChannelInfo?.name || '...'}`}
              className="flex-1 px-3 py-2 rounded text-sm outline-none"
              style={{ 
                background: 'var(--bg-base)', 
                border: '1px solid var(--border)', 
                color: 'var(--text-primary)' 
              }}
              disabled={!session}
            />
            <button
              type="submit"
              disabled={!input.trim() || !session}
              className="px-4 py-2 rounded text-sm font-medium transition-colors"
              style={{ 
                background: session ? '#16a34a' : '#4b5563', 
                color: '#ffffff',
                opacity: (!input.trim() || !session) ? 0.5 : 1
              }}
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
          {!session && (
            <p className="text-xs mt-2 text-center" style={{ color: '#f87171' }}>
              Sign in to send messages to Discord
            </p>
          )}
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setShowSettings(false)}
        >
          <div 
            className="w-full max-w-md rounded-lg p-5"
            style={{ background: '#1e4d2b', border: '1px solid #0e3a20' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold" style={{ color: '#ffffff' }}>
                Discord Settings
              </h3>
              <button
                onClick={() => setShowSettings(false)}
                className="p-1 rounded transition-colors"
                style={{ color: '#b9cdb2' }}
                onMouseEnter={e => { e.currentTarget.style.color = '#ffffff'; }}
                onMouseLeave={e => { e.currentTarget.style.color = '#b9cdb2'; }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-xs mb-1.5" style={{ color: '#b9cdb2' }}>
                  Discord Bot Token
                </label>
                <input
                  type="text"
                  value={process.env.DISCORD_BOT_TOKEN || 'Not configured'}
                  readOnly
                  className="w-full px-3 py-2 rounded text-xs outline-none"
                  style={{ 
                    background: '#14532d', 
                    border: '1px solid #0e3a20', 
                    color: '#9ca3af',
                    fontFamily: 'monospace'
                  }}
                />
              </div>
              
              <div>
                <label className="block text-xs mb-1.5" style={{ color: '#b9cdb2' }}>
                  Server ID (Optional)
                </label>
                <input
                  type="text"
                  value={process.env.DISCORD_SERVER_ID || 'All servers'}
                  readOnly
                  className="w-full px-3 py-2 rounded text-xs outline-none"
                  style={{ 
                    background: '#14532d', 
                    border: '1px solid #0e3a20', 
                    color: '#9ca3af',
                    fontFamily: 'monospace'
                  }}
                />
              </div>
              
              <p className="text-xs" style={{ color: '#b9cdb2' }}>
                To configure Discord integration, set these environment variables in <code className="text-[#6b7280]">api/.env</code>:
              </p>
              
              <ul className="text-xs space-y-1 list-disc pl-5" style={{ color: '#9ca3af' }}>
                <li><code className="text-[#6b7280]">DISCORD_BOT_TOKEN</code> - Bot token for full channel access</li>
                <li><code className="text-[#6b7280]">DISCORD_SERVER_ID</code> - Optional: specific server ID</li>
              </ul>
              
              <p className="text-xs mt-3" style={{ color: '#6b7280' }}>
                <strong>Bot permissions needed:</strong> Read/Write Messages, Embed Links
              </p>
            </div>
            
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 rounded text-sm"
                style={{ background: '#374151', color: '#ffffff' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
