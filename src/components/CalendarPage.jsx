import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, Clock, MapPin, Plus } from 'lucide-react';
import EventDialog from './EventDialog';

export default function CalendarPage({ session, setCurrentView }) {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [events, setEvents] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showEventDialog, setShowEventDialog] = useState(false);

  // Load events from database API
  useEffect(() => {
    const loadEvents = async () => {
      try {
        const response = await fetch('/api/events');
        if (response.ok) {
          const data = await response.json();
          // Filter to show only approved events (pending events need voting first)
          const approvedEvents = data.filter(e => e.status === 'approved');
          setEvents(approvedEvents);
        }
      } catch (err) {
        console.error('Error loading events:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadEvents();
  }, []);

  const getEventsForDay = (date) => {
    const dayEvents = events.filter(e => {
      const eventDate = new Date(e.date);
      return eventDate.getDate() === date.getDate() &&
             eventDate.getMonth() === date.getMonth() &&
             eventDate.getFullYear() === date.getFullYear();
    });
    return dayEvents;
  };

  const formatMonthYear = (date) => {
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  const getDaysInMonth = (date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  };

  const getFirstDayOfMonth = (date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  };

  const daysInMonth = getDaysInMonth(currentMonth);
  const firstDay = getFirstDayOfMonth(currentMonth);

  const calendarDays = [];
  // Empty slots for days before the first day of the month
  for (let i = 0; i < firstDay; i++) {
    calendarDays.push(null);
  }
  // Days of the month
  for (let day = 1; day <= daysInMonth; day++) {
    calendarDays.push(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day));
  }

  return (
    <div className="min-h-screen py-16 px-6" style={{ background: 'var(--bg-base)' }}>
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="mb-12 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest mb-3" style={{ color: 'var(--text-subtle)' }}>
              Meeting Schedule
            </p>
            <h1 className="text-2xl font-semibold mb-2"
                style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
              Meeting Calendar
            </h1>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Join us for our weekly meetings and special events.
            </p>
          </div>
          <button
            onClick={() => setShowEventDialog(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ background: '#0066B3', color: '#fff' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#0077cc'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#0066B3'; }}>
            <Plus className="w-4 h-4" />
            Add Event
          </button>
        </div>

        {/* Calendar */}
        <div className="p-6 rounded-xl" style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
              {formatMonthYear(currentMonth)}
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCurrentMonth(new Date(currentMonth.setMonth(currentMonth.getMonth() - 1)))}
                className="p-2 rounded-lg transition-colors"
                style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-subtle)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}>
                <ChevronLeft className="w-4 h-4" style={{ color: 'var(--text-primary)' }} />
              </button>
              <button
                onClick={() => setCurrentMonth(new Date(currentMonth.setMonth(currentMonth.getMonth() + 1)))}
                className="p-2 rounded-lg transition-colors"
                style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-subtle)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}>
                <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-primary)' }} />
              </button>
            </div>
          </div>

          {/* Weekdays */}
          <div className="grid grid-cols-7 mb-2">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
              <div key={day} className="text-center text-sm font-medium"
                   style={{ color: 'var(--text-subtle)' }}>
                {day}
              </div>
            ))}
          </div>

          {/* Days Grid */}
          <div className="grid grid-cols-7 gap-1">
            {isLoading ? (
              <div className="col-span-7 py-8 text-center" style={{ color: 'var(--text-subtle)' }}>
                Loading events...
              </div>
            ) : (
              calendarDays.map((day, i) => {
                if (!day) {
                  return <div key={i} className="aspect-square" />;
                }

                const dayEvents = getEventsForDay(day);
                const isToday = day.getDate() === new Date().getDate() &&
                                day.getMonth() === new Date().getMonth() &&
                                day.getFullYear() === new Date().getFullYear();

                return (
                  <div key={i} className={`aspect-square rounded-lg flex flex-col items-center justify-center p-1 relative transition-colors ${isToday ? 'bg-#0066B3/10' : ''}`}
                       style={{ background: isToday ? 'rgba(0, 102, 179, 0.1)' : 'transparent' }}>
                    <span className="text-sm font-medium"
                          style={{ color: isToday ? '#0066B3' : 'var(--text-primary)' }}>
                      {day.getDate()}
                    </span>
                    {/* Events dots for this day */}
                    {dayEvents.length > 0 && (
                      <div className="flex flex-wrap gap-0.5 justify-center mt-1">
                        {dayEvents.slice(0, 3).map((event, idx) => (
                          <div key={idx} className="w-1 h-1 rounded-full"
                               style={{ background: event.isMeeting ? '#0066B3' : '#FFC72C' }} />
                        ))}
                        {dayEvents.length > 3 && (
                          <span className="text-[9px] leading-none"
                                style={{ color: 'var(--text-subtle)' }}>
                            +{dayEvents.length - 3}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Legend */}
          <div className="mt-6 pt-6 border-t" style={{ borderColor: 'var(--border)' }}>
            <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>
              Legend
            </h3>
            <div className="flex flex-wrap gap-4 text-xs">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ background: '#0066B3' }} />
                <span className="text-gray-400">Regular Meeting</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ background: '#FFC72C' }} />
                <span className="text-gray-400">Special Event</span>
              </div>
            </div>
          </div>
        </div>

        {/* Meeting Info */}
        <div className="mt-8 grid md:grid-cols-2 gap-6">
          <div className="p-6 rounded-xl"
               style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)' }}>
            <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
              Wednesday Lunch Meeting
            </h3>
            <p className="text-sm text-gray-400 mb-4">
              Join us during lunch hour in Room F1 for our weekly Wednesday meeting. All members are welcome!
            </p>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <CalendarIcon className="w-4 h-4" />
                <span>Wednesdays</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <Clock className="w-4 h-4" />
                <span>Lunch hour</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <MapPin className="w-4 h-4" />
                <span>Room F1</span>
              </div>
            </div>
          </div>

          <div className="p-6 rounded-xl"
               style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)' }}>
            <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
              Thursday Afternoon Meeting
            </h3>
            <p className="text-sm text-gray-400 mb-4">
              Extended meeting with robotics shop access from 4:00 PM to 6:00 PM in Room C5.
            </p>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <CalendarIcon className="w-4 h-4" />
                <span>Thursdays</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <Clock className="w-4 h-4" />
                <span>4:00 PM - 6:00 PM</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <MapPin className="w-4 h-4" />
                <span>Room C5</span>
              </div>
            </div>
          </div>
        </div>

        {/* FAQ Link */}
        <div className="mt-8 p-6 rounded-xl"
             style={{ background: 'rgba(0, 102, 179, 0.05)', border: '1px solid rgba(0, 102, 179, 0.2)' }}>
          <h3 className="text-base font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
            Need More Information?
          </h3>
          <p className="text-sm text-gray-400 mb-4">
            Check our FAQ for answers to common questions about meeting schedules, build season, and more.
          </p>
          <a href="#"
             onClick={(e) => { e.preventDefault(); setCurrentView('faq'); }}
             className="inline-flex items-center gap-2 text-sm font-medium transition-colors"
             style={{ color: '#0066B3' }}
             onMouseEnter={e => { e.currentTarget.style.color = '#0077cc'; }}
             onMouseLeave={e => { e.currentTarget.style.color = '#0066B3'; }}>
            View FAQ
          </a>
        </div>

        <p className="mt-12 text-xs" style={{ color: 'var(--text-subtle)' }}>
          © {new Date().getFullYear()} MCHS Robotics · Team 5728
        </p>
      </div>
      
      {/* Event Creation Dialog */}
      {showEventDialog && session && (
        <EventDialog
          session={session}
          onClose={() => setShowEventDialog(false)}
          onEventCreated={(event) => {
            console.log('Event created:', event);
            // Reload events after creation
            loadEvents();
          }}
        />
      )}
      
      {!session && showEventDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
          <div className="w-full max-w-md p-6 rounded-xl text-center" style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)' }}>
            <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
              Please Login First
            </h3>
            <p className="text-sm text-gray-400 mb-4">
              You must be logged in to propose events.
            </p>
            <button
              onClick={() => setShowEventDialog(false)}
              className="px-4 py-2 rounded text-sm font-medium transition-colors"
              style={{ background: '#0066B3', color: '#fff' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#0077cc'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#0066B3'; }}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
