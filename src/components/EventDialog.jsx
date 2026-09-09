import { useState } from 'react';
import { X, Calendar as CalendarIcon, Clock, MapPin, Check, X as XIcon, Send } from 'lucide-react';

export default function EventDialog({ session, onClose, onEventCreated }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('12:00');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('meeting');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    if (!title.trim() || !date) {
      setError('Title and date are required');
      return;
    }
    
    setIsSubmitting(true);
    
    try {
      const response = await fetch('/api/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.token}`,
        },
        body: JSON.stringify({
          title,
          date: `${date}T${time}:00`,
          location: location || 'TBD',
          description,
          type
        })
      });
      
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to create event');
      }
      
      const event = await response.json();
      setShowSuccess(true);
      setTimeout(() => {
        if (onEventCreated) onEventCreated(event);
        onClose();
      }, 2000);
    } catch (err) {
      setError(err.message || 'An error occurred');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (showSuccess) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
        <div className="w-full max-w-md p-8 rounded-xl text-center" style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)' }}>
          <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center"
               style={{ background: 'rgba(34,197,94,0.1)' }}>
            <Check className="w-8 h-8 text-green-500" />
          </div>
          <h3 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
            Event Proposed!
          </h3>
          <p className="text-sm text-gray-400">
            Your event has been submitted for voting. Check the board for the proposal thread.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="w-full max-w-lg" onClick={onClose}>
        <div className="w-full max-w-md p-6 rounded-xl" style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
              Propose New Event
            </h2>
            <button onClick={onClose}
                    className="p-2 rounded-lg transition-colors"
                    style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-subtle)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}>
              <X className="w-5 h-5" style={{ color: 'var(--text-primary)' }} />
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Title */}
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                Event Title
              </label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g., Robotics Workshop"
                className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors"
                style={{
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)'
                }}
                onFocus={e => e.target.style.borderColor = 'var(--border-light)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
                disabled={isSubmitting}
              />
            </div>

            {/* Date & Time */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                  Date
                </label>
                <div className="relative">
                  <CalendarIcon className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                  <input
                    type="date"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    className="w-full pl-9 px-3 py-2 rounded-lg text-sm outline-none transition-colors"
                    style={{
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-primary)'
                    }}
                    onFocus={e => e.target.style.borderColor = 'var(--border-light)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                    disabled={isSubmitting}
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                  Time
                </label>
                <div className="relative">
                  <Clock className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                  <input
                    type="time"
                    value={time}
                    onChange={e => setTime(e.target.value)}
                    className="w-full pl-9 px-3 py-2 rounded-lg text-sm outline-none transition-colors"
                    style={{
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-primary)'
                    }}
                    onFocus={e => e.target.style.borderColor = 'var(--border-light)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                    disabled={isSubmitting}
                  />
                </div>
              </div>
            </div>

            {/* Location */}
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                Location
              </label>
              <div className="relative">
                <MapPin className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={location}
                  onChange={e => setLocation(e.target.value)}
                  placeholder="e.g., Room C5"
                  className="w-full pl-9 px-3 py-2 rounded-lg text-sm outline-none transition-colors"
                  style={{
                    background: 'var(--bg-base)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)'
                  }}
                  onFocus={e => e.target.style.borderColor = 'var(--border-light)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  disabled={isSubmitting}
                />
              </div>
            </div>

            {/* Type */}
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                Event Type
              </label>
              <select
                value={type}
                onChange={e => setType(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors"
                style={{
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)'
                }}
                onFocus={e => e.target.style.borderColor = 'var(--border-light)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
                disabled={isSubmitting}>
                <option value="meeting">Weekly Meeting</option>
                <option value="event">Special Event</option>
                <option value="workshop">Workshop</option>
                <option value="competition">Competition</option>
              </select>
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                Description
              </label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Add details about this event..."
                rows={3}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors resize-none"
                style={{
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)'
                }}
                onFocus={e => e.target.style.borderColor = 'var(--border-light)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
                disabled={isSubmitting}
              />
            </div>

            {/* Submit */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: '#0066B3', color: '#fff' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#0077cc'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#0066B3'; }}>
                <Send className="w-4 h-4" />
                {isSubmitting ? 'Submitting...' : 'Submit Event for Voting'}
              </button>
              <p className="mt-3 text-xs text-center" style={{ color: 'var(--text-subtle)' }}>
                Submitted events will be posted to the team board for voting.
                Events with majority approval will be added to the calendar.
              </p>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
