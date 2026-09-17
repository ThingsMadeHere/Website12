import { Bell, BellOff, Users, X, Check } from 'lucide-react';

const NOTIFICATION_OPTIONS = [
  {
    value: 'all',
    title: 'All Messages',
    description: 'Get notified for all messages when online, only mentions when offline',
    icon: Bell,
    color: '#16a34a'
  },
  {
    value: 'mentions_only',
    title: 'Mentions Only',
    description: 'Only get notified when you are @mentioned or @everyone is used',
    icon: Users,
    color: '#a16207'
  },
  {
    value: 'none',
    title: 'None',
    description: 'Disable all notifications',
    icon: BellOff,
    color: '#dc2626'
  }
];

export default function NotificationSettings({ settings, onChange, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div 
        className="w-full max-w-md rounded-xl p-6"
        style={{ 
          background: 'var(--bg-elevated)', 
          border: '1px solid var(--border)' 
        }}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            Notification Settings
          </h2>
          <button 
            onClick={onClose}
            className="p-1 rounded transition-colors"
            style={{ color: 'var(--text-subtle)' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          {NOTIFICATION_OPTIONS.map((option) => {
            const Icon = option.icon;
            const isSelected = settings === option.value;
            
            return (
              <button
                key={option.value}
                onClick={() => onChange(option.value)}
                className="w-full p-4 rounded-lg text-left transition-all duration-200 flex items-start gap-3"
                style={{
                  background: isSelected 
                    ? `${option.color}15` 
                    : 'var(--bg-base)',
                  border: isSelected 
                    ? `2px solid ${option.color}` 
                    : '1px solid var(--border)',
                }}
              >
                <div 
                  className="p-2 rounded-lg"
                  style={{ background: `${option.color}20` }}
                >
                  <Icon 
                    className="w-5 h-5" 
                    style={{ color: option.color }} 
                  />
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span 
                      className="font-medium"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {option.title}
                    </span>
                    {isSelected && (
                      <Check 
                        className="w-4 h-4 shrink-0" 
                        style={{ color: option.color }} 
                      />
                    )}
                  </div>
                  <p 
                    className="text-sm leading-relaxed"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {option.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-6 p-3 rounded-lg" style={{ background: 'var(--bg-base)' }}>
          <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Discord-style notifications:</strong> When you're online, notifications follow your chosen settings. When you're offline (browser closed), you'll only receive notifications for @mentions or @everyone.
          </p>
        </div>

        <button
          onClick={onClose}
          className="w-full mt-4 py-2.5 rounded-lg font-medium transition-colors"
          style={{ 
            background: 'var(--accent)', 
            color: '#fff' 
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}