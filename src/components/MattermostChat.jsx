import { useState, useEffect } from 'react';
import { MessageSquare, X, Zap } from 'lucide-react';

const MATTERMOST_URL = import.meta.env.VITE_MATTERMOST_URL || 'https://chat.mchsrobotics.dev';

export default function MattermostChat({ session }) {
  const [iframeKey, setIframeKey] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [customUrl, setCustomUrl] = useState(MATTERMOST_URL);

  // Force iframe reload when session changes (to refresh auth context if needed)
  useEffect(() => {
    setIframeKey(prev => prev + 1);
  }, [session?.token]);

  const handleRefresh = () => {
    setIframeKey(prev => prev + 1);
  };

  const handleSaveUrl = () => {
    if (customUrl.trim()) {
      localStorage.setItem('mchs_mattermost_url', customUrl.trim());
      setCustomUrl(customUrl.trim());
      setShowSettings(false);
      handleRefresh();
    }
  };

  // Load custom URL from localStorage if available
  useEffect(() => {
    const stored = localStorage.getItem('mchs_mattermost_url');
    if (stored && stored !== MATTERMOST_URL) {
      setCustomUrl(stored);
    }
  }, []);

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      {/* Chat header */}
      <div 
        className="px-4 py-2 flex items-center justify-between shrink-0"
        style={{ borderBottom: '1px solid #0e3a20', background: '#14532d' }}
      >
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4" style={{ color: '#ffc72c' }} />
          <h2 className="text-sm font-semibold" style={{ color: '#ffffff' }}>
            Team Chat
          </h2>
          <span 
            className="text-xs px-1.5 py-0.5 rounded"
            style={{ 
              background: 'rgba(34,197,94,0.1)', 
              color: '#166534',
              border: '1px solid rgba(34,197,94,0.2)' 
            }}
          >
            Zulip
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              const url = prompt('Enter Zulip server URL:', customUrl);
              if (url && url.trim()) {
                const trimmed = url.trim().replace(/\/+$/, '');
                localStorage.setItem('mchs_mattermost_url', trimmed);
                setCustomUrl(trimmed);
                setIframeKey(prev => prev + 1);
              }
            }}
            title="Change Zulip server URL"
            className="p-1.5 rounded transition-colors"
            style={{ color: '#b9cdb2' }}
            onMouseEnter={e => { e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = '#b9cdb2'; e.currentTarget.style.background = 'transparent'; }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
          </button>

          <button
            onClick={handleRefresh}
            title="Refresh chat"
            className="p-1.5 rounded transition-colors"
            style={{ color: '#b9cdb2' }}
            onMouseEnter={e => { e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = '#b9cdb2'; e.currentTarget.style.background = 'transparent'; }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>

          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            className="p-1.5 rounded transition-colors"
            style={{ color: '#b9cdb2' }}
            onMouseEnter={e => { e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = '#b9cdb2'; e.currentTarget.style.background = 'transparent'; }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Zulip iframe */}
      <div className="flex-1 relative">
        <iframe
          key={iframeKey}
          src={`${customUrl.replace(/\/+$/, '')}/`}
          title="Zulip Chat"
          className="w-full h-full border-0"
          allow="camera; microphone; screen-share; autoplay; encrypted-media"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        />
        
        {/* Loading state overlay */}
        <div 
          className="absolute inset-0 flex items-center justify-center z-10"
          style={{ background: 'rgba(20,83,45,0.8)' }}
        >
          <div className="text-center">
            <div 
              className="inline-block w-8 h-8 border-2 border-transparent border-t-white rounded-full animate-spin mb-3"
              style={{ borderColor: 'rgba(255,255,255,0.3)', borderTopColor: '#ffffff' }}
            />
            <p className="text-white text-sm">Loading Zulip...</p>
          </div>
        </div>
      </div>

      {/* Settings modal */}
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
                Zulip Settings
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
            
            <div className="space-y-3">
              <div>
                <label className="block text-xs mb-1.5" style={{ color: '#b9cdb2' }}>
                  Zulip Server URL
                </label>
                <input
                  type="text"
                  value={customUrl}
                  onChange={e => setCustomUrl(e.target.value)}
                  className="w-full px-3 py-2 rounded text-sm outline-none"
                  style={{ 
                    background: '#14532d', 
                    border: '1px solid #0e3a20', 
                    color: '#ffffff',
                    fontFamily: 'monospace'
                  }}
                  placeholder="https://chat.mchsrobotics.dev"
                />
              </div>
              
              <p className="text-xs" style={{ color: '#b9cdb2' }}>
                Enter your Zulip server URL. The chat will load in an iframe below.
                <br/>
                <span style={{ color: '#9ca3af' }}>
                  Current URL: <span style={{ color: '#60a5fa' }}>{customUrl}</span>
                </span>
              </p>
            </div>
            
            <div className="flex gap-2 mt-5">
              <button
                onClick={handleSaveUrl}
                className="flex-1 py-2 rounded text-sm font-medium"
                style={{ background: '#16a34a', color: '#ffffff' }}
              >
                Save
              </button>
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 rounded text-sm"
                style={{ background: '#374151', color: '#ffffff' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
