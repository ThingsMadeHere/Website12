import { useState } from 'react';
import { Mail, Settings, AlertCircle } from 'lucide-react';

function EmailInbox() {
  const [error, setError] = useState(null);

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-white rounded-lg overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
        <div className="flex items-center gap-2">
          <Mail className="w-5 h-5 text-gray-600" />
          <h1 className="text-lg font-semibold text-gray-800">Email Inbox</h1>
        </div>
        <div className="flex items-center gap-3">
          <Settings className="w-4 h-4 text-gray-500 cursor-pointer hover:text-gray-700" />
        </div>
      </div>

      {/* Error banner if iframe fails */}
      {error && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-3 flex items-center gap-3 text-sm text-red-700">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span>Failed to load email inbox. Please try again later.</span>
        </div>
      )}

      {/* Email iframe container */}
      <div className="flex-1 relative">
        <iframe
          src="http://100.115.4.34:3000/ui"
          title="Email Inbox"
          className="w-full h-full border-0"
          loading="lazy"
          onLoad={() => setError(null)}
          onError={() => setError(true)}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
        />
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-0 transition-opacity duration-300" id="email-iframe-overlay">
          <div className="bg-white/90 px-6 py-3 rounded-lg shadow-lg text-sm text-gray-600">
            Loading email inbox...
          </div>
        </div>
      </div>

      {/* Footer info */}
      <div className="px-4 py-2 bg-gray-50 border-t text-xs text-gray-500 flex justify-between items-center">
        <span>Connected to external email server</span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
          Online
        </span>
      </div>
    </div>
  );
}

export default EmailInbox;
