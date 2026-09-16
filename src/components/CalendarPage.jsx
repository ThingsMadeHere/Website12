import { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, Clock, MapPin, Plus, ThumbsUp, ThumbsDown, Trash2, Vote, X as XIcon } from 'lucide-react';
import EventDialog from './EventDialog';

const fmtProposalDate = (d) => {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return d;
  return date.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export default function CalendarPage({ session, setCurrentView }) {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [events, setEvents]         = useState([]);  // approved → shown on the calendar
  const [proposals, setProposals]   = useState([]);  // pending  → shown in the voting panel
  const [votes, setVotes]           = useState({});  // eventId → { userId: 1 | -1 }
  const [isLoading, setIsLoading]   = useState(true);
  const [showEventDialog, setShowEventDialog] = useState(false);
  const [busyEventId, setBusyEventId] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null); // Date | null → day-detail modal

  // Load events (+ vote tallies for pending proposals).
  // Defined at component scope so the dialog's onEventCreated can call it.
  const loadEvents = useCallback(async () => {
    try {
      const response = await fetch('/api/events');
      if (response.ok) {
        const data = await response.json();
        setEvents(data.filter(e => e.status === 'approved'));
        const pending = data.filter(e => e.status === 'pending');
        setProposals(pending);

        // tallies for the proposals panel
        const entries = await Promise.all(pending.map(async (e) => {
          try {
            const r = await fetch(`/api/events/${e.id}/votes`);
            return r.ok ? [e.id, (await r.json()).votes || {}] : [e.id, {}];
          } catch { return [e.id, {}]; }
        }));
        setVotes(Object.fromEntries(entries));
      }
    } catch (err) {
      console.error('Error loading events:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  // ── voting ────────────────────────────────────────────────────────────────
  const handleVote = async (event, vote) => {
    if (!session) { setCurrentView('chat'); return; } // sign-in gate
    setBusyEventId(event.id);
    try {
      const res = await fetch(`/api/events/${event.id}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ vote }),
      });
      if (res.status === 401) { setCurrentView('chat'); return; }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Could not vote');
        return;
      }
      const totals = await res.json();
      // majority reached? → promote to the calendar (server double-checks)
      const majority = Math.floor((totals.total_votes || 0) / 2) + 1;
      if ((totals.yes_votes || 0) >= majority) {
        await fetch(`/api/events/${event.id}/approve`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${session.token}` },
        }).catch(() => {});
      }
      await loadEvents();
    } catch {
      /* ignore */
    } finally {
      setBusyEventId(null);
    }
  };

  const handleDeleteEvent = async (event) => {
    if (!window.confirm(`Delete "${event.title}"?`)) return;
    setBusyEventId(event.id);
    try {
      const res = await fetch(`/api/events/${event.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.token}` },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Could not delete event');
        return;
      }
      await loadEvents();
    } catch {
      /* ignore */
    } finally {
      setBusyEventId(null);
    }
  };

  const canDeleteEvent = (ev) =>
    !!session && (session.admin ||
      (ev.proposedBy != null && Number(ev.proposedBy) === Number(session.userId)));

  // 'YYYY-MM-DD' (legacy rows) parses as UTC midnight — shift it to local so
  // day matching doesn't land on the wrong date in negative-offset timezones.
  const parseEventDate = (s) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(s))) {
      const [y, m, d] = String(s).split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    return new Date(s);
  };

  const sameDay = (a, b) =>
    a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();

  const getEventsForDay = (date) =>
    events.filter(e => { const d = parseEventDate(e.date); return !Number.isNaN(d) && sameDay(d, date); });

  const getProposalsForDay = (date) =>
    proposals.filter(e => { const d = parseEventDate(e.date); return !Number.isNaN(d) && sameDay(d, date); });

  const fmtEventTime = (dateStr) => {
    if (!String(dateStr).includes('T')) return null; // date-only → no time to show
    const d = new Date(dateStr);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Close the day modal with Escape
  useEffect(() => {
    if (!selectedDay) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setSelectedDay(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedDay]);

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
    <div className="min-h-screen py-8 sm:py-16 px-3 sm:px-6" style={{ background: 'var(--bg-base)' }}>
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="mb-8 sm:mb-12 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
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
            className="flex items-center justify-center gap-2 w-full sm:w-auto px-4 py-2.5 sm:py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ background: '#16a34a', color: '#fff' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#15803d'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#16a34a'; }}>
            <Plus className="w-4 h-4" />
            Add Event
          </button>
        </div>

        {/* Calendar */}
        <div className="p-3 sm:p-6 rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between mb-4 sm:mb-6">
            <h2 className="text-lg sm:text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
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
              <div key={day} className="text-center text-[10px] sm:text-sm font-medium"
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
                const isSelected = selectedDay &&
                                day.getDate() === selectedDay.getDate() &&
                                day.getMonth() === selectedDay.getMonth() &&
                                day.getFullYear() === selectedDay.getFullYear();

                return (
                  <button key={i}
                          onClick={() => setSelectedDay(day)}
                          title={dayEvents.length
                            ? `${dayEvents.length} event${dayEvents.length > 1 ? 's' : ''} — click for details`
                            : 'Click for details'}
                          className={`day-cell aspect-square rounded-lg flex flex-col items-center justify-center p-0.5 sm:p-1 relative transition-colors
                                      ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}>
                    <span className="text-xs sm:text-sm font-medium"
                          style={{ color: isToday ? 'var(--gold)' : 'var(--text-primary)' }}>
                      {day.getDate()}
                    </span>
                    {/* Events dots for this day */}
                    {dayEvents.length > 0 && (
                      <div className="flex flex-wrap gap-0.5 justify-center mt-1">
                        {dayEvents.slice(0, 3).map((event, idx) => (
                          <div key={idx} className="w-1 h-1 rounded-full"
                               style={{ background: event.isMeeting ? '#16a34a' : '#FFC72C' }} />
                        ))}
                        {dayEvents.length > 3 && (
                          <span className="text-[9px] leading-none"
                                style={{ color: 'var(--text-subtle)' }}>
                            +{dayEvents.length - 3}
                          </span>
                        )}
                      </div>
                    )}
                  </button>
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
                <div className="w-3 h-3 rounded-full" style={{ background: '#16a34a' }} />
                <span className="text-gray-400">Regular Meeting</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ background: '#FFC72C' }} />
                <span className="text-gray-400">Special Event</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Proposals awaiting votes ── */}
        {proposals.length > 0 && (
          <div className="mt-6 sm:mt-8">
            <div className="flex items-center gap-2 mb-1">
              <Vote className="w-4 h-4" style={{ color: '#a16207' }} />
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                Proposals awaiting votes
              </h2>
              <span className="text-xs px-2 py-0.5 rounded-full"
                    style={{ background: 'rgba(255,199,44,0.1)', color: '#a16207', border: '1px solid rgba(255,199,44,0.25)' }}>
                {proposals.length}
              </span>
            </div>
            <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
              New event proposals land here — once a majority votes 👍, the event moves onto the calendar
              automatically.{!session && ' Sign in to vote.'}
            </p>

            <div className="space-y-3">
              {proposals.map(ev => {
                const tally    = votes[ev.id] || {};
                const values   = Object.values(tally);
                const yes      = values.filter(v => v === 1).length;
                const no       = values.filter(v => v === -1).length;
                const total    = values.length;
                const majority = Math.floor(total / 2) + 1;
                const needed   = Math.max(0, majority - yes);
                const myVote   = session ? tally[String(session.userId)] : undefined;
                const isMine   = session && ev.proposedBy != null && Number(ev.proposedBy) === Number(session.userId);
                const canDelete = session && (isMine || session.admin);
                const busy     = busyEventId === ev.id;

                return (
                  <div key={ev.id} className="p-4 sm:p-5 rounded-xl"
                       style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                    <div className="flex flex-col sm:flex-row gap-4">
                      {/* Details */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {ev.title}
                          </h3>
                          {isMine && (
                            <span className="text-xs px-1.5 py-0.5 rounded"
                                  style={{ background: 'rgba(255,199,44,0.12)', color: '#a16207', border: '1px solid rgba(255,199,44,0.32)' }}>
                              yours
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
                          <span className="flex items-center gap-1.5">
                            <CalendarIcon className="w-3.5 h-3.5" style={{ color: 'var(--text-subtle)' }} />
                            {fmtProposalDate(ev.date)}
                          </span>
                          {ev.location && (
                            <span className="flex items-center gap-1.5">
                              <MapPin className="w-3.5 h-3.5" style={{ color: 'var(--text-subtle)' }} />
                              {ev.location}
                            </span>
                          )}
                          {ev.proposerName && (
                            <span style={{ color: 'var(--text-subtle)' }}>
                              proposed by @{ev.proposerName}
                            </span>
                          )}
                        </div>
                        {ev.description && (
                          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                            {ev.description}
                          </p>
                        )}
                      </div>

                      {/* Vote controls */}
                      <div className="shrink-0 flex flex-row sm:flex-col items-center sm:items-end gap-2">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleVote(ev, 1)}
                            disabled={busy}
                            title={session ? 'Vote yes' : 'Sign in to vote'}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                            style={{
                              background: myVote === 1 ? 'rgba(34,197,94,0.18)' : 'var(--bg-base)',
                              color:      myVote === 1 ? '#166534' : 'var(--text-muted)',
                              border:     `1px solid ${myVote === 1 ? 'rgba(34,197,94,0.4)' : 'var(--border)'}`,
                            }}>
                            <ThumbsUp className="w-3.5 h-3.5" /> {yes}
                          </button>
                          <button
                            onClick={() => handleVote(ev, -1)}
                            disabled={busy}
                            title={session ? 'Vote no' : 'Sign in to vote'}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                            style={{
                              background: myVote === -1 ? 'rgba(239,68,68,0.15)' : 'var(--bg-base)',
                              color:      myVote === -1 ? '#dc2626' : 'var(--text-muted)',
                              border:     `1px solid ${myVote === -1 ? 'rgba(239,68,68,0.35)' : 'var(--border)'}`,
                            }}>
                            <ThumbsDown className="w-3.5 h-3.5" /> {no}
                          </button>
                          {canDelete && (
                            <button
                              onClick={() => handleDeleteEvent(ev)}
                              disabled={busy}
                              title={isMine ? 'Delete your proposal' : 'Delete proposal (admin)'}
                              className="p-1.5 rounded-lg transition-colors disabled:opacity-50"
                              style={{ color: 'var(--text-subtle)', border: '1px solid var(--border)' }}
                              onMouseEnter={e => { e.currentTarget.style.color = '#dc2626'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)'; }}
                              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-subtle)'; e.currentTarget.style.borderColor = 'var(--border)'; }}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>
                          {total === 0
                            ? 'no votes yet'
                            : needed > 0
                              ? `needs ${needed} more 👍 for majority`
                              : 'majority reached — approving…'}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Meeting Info */}
        <div className="mt-6 sm:mt-8 grid md:grid-cols-2 gap-4 sm:gap-6">
          <div className="p-4 sm:p-6 rounded-xl"
               style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
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

          <div className="p-4 sm:p-6 rounded-xl"
               style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
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
        <div className="mt-6 sm:mt-8 p-4 sm:p-6 rounded-xl"
             style={{ background: 'rgba(22, 163, 74, 0.05)', border: '1px solid rgba(22, 163, 74, 0.2)' }}>
          <h3 className="text-base font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
            Need More Information?
          </h3>
          <p className="text-sm text-gray-400 mb-4">
            Check our FAQ for answers to common questions about meeting schedules, build season, and more.
          </p>
          <a href="#"
             onClick={(e) => { e.preventDefault(); setCurrentView('faq'); }}
             className="inline-flex items-center gap-2 text-sm font-medium transition-colors"
             style={{ color: '#16a34a' }}
             onMouseEnter={e => { e.currentTarget.style.color = '#166534'; }}
             onMouseLeave={e => { e.currentTarget.style.color = '#16a34a'; }}>
            View FAQ
          </a>
        </div>

        <p className="mt-12 text-xs" style={{ color: 'var(--text-subtle)' }}>
          © {new Date().getFullYear()} MCHS Robotics · Team 5728
        </p>
      </div>
      
      {/* ── Day detail modal ── */}
      {selectedDay && (() => {
        const dayEvents     = getEventsForDay(selectedDay);
        const dayProposals  = getProposalsForDay(selectedDay);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 cursor-pointer"
               style={{ background: 'rgba(0,0,0,0.7)' }}
               onClick={() => setSelectedDay(null)}>
            <div className="w-full max-w-md rounded-xl p-5 sm:p-6 cursor-default"
                 style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', maxHeight: '85dvh', overflowY: 'auto' }}
                 onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-widest mb-1" style={{ color: 'var(--text-subtle)' }}>
                    {selectedDay.toLocaleDateString('en-US', { weekday: 'long' })}
                  </p>
                  <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {selectedDay.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                  </h3>
                </div>
                <button onClick={() => setSelectedDay(null)} title="Close"
                  className="p-2 rounded-lg transition-colors shrink-0"
                  style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-subtle)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}>
                  <XIcon className="w-4 h-4" style={{ color: 'var(--text-primary)' }} />
                </button>
              </div>

              {dayEvents.length === 0 && dayProposals.length === 0 && (
                <div className="py-8 text-center">
                  <CalendarIcon className="w-6 h-6 mx-auto mb-2" style={{ color: 'var(--text-subtle)' }} />
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No events scheduled this day.</p>
                  {session && (
                    <button onClick={() => { setSelectedDay(null); setShowEventDialog(true); }}
                      className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                      style={{ background: 'var(--accent)', color: '#fff' }}>
                      <Plus className="w-3.5 h-3.5" /> Propose an event
                    </button>
                  )}
                </div>
              )}

              <div className="space-y-3">
                {/* Approved events */}
                {dayEvents.map(ev => (
                  <div key={ev.id} className="p-3 sm:p-4 rounded-lg"
                       style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="w-2 h-2 rounded-full shrink-0"
                                style={{ background: ev.isMeeting ? '#16a34a' : '#FFC72C' }} />
                          <h4 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {ev.title}
                          </h4>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                          {fmtEventTime(ev.date) && (
                            <span className="flex items-center gap-1">
                              <Clock className="w-3.5 h-3.5" style={{ color: 'var(--text-subtle)' }} />
                              {fmtEventTime(ev.date)}
                            </span>
                          )}
                          {ev.location && (
                            <span className="flex items-center gap-1">
                              <MapPin className="w-3.5 h-3.5" style={{ color: 'var(--text-subtle)' }} />
                              {ev.location}
                            </span>
                          )}
                          <span style={{ color: 'var(--text-subtle)' }}>
                            {ev.isMeeting ? 'Regular meeting' : 'Special event'}
                          </span>
                        </div>
                        {ev.description && (
                          <p className="text-xs mt-1.5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                            {ev.description}
                          </p>
                        )}
                      </div>
                      {canDeleteEvent(ev) && (
                        <button onClick={() => handleDeleteEvent(ev)} disabled={busyEventId === ev.id}
                          title={session?.admin ? 'Delete event (admin)' : 'Delete your event'}
                          className="p-1.5 rounded-lg transition-colors shrink-0 disabled:opacity-50"
                          style={{ color: 'var(--text-subtle)', border: '1px solid var(--border)' }}
                          onMouseEnter={e => { e.currentTarget.style.color = '#dc2626'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)'; }}
                          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-subtle)'; e.currentTarget.style.borderColor = 'var(--border)'; }}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}

                {/* Pending proposals for this day */}
                {dayProposals.map(ev => (
                  <div key={`p-${ev.id}`} className="p-3 sm:p-4 rounded-lg"
                       style={{ background: 'var(--bg-base)', border: '1px dashed rgba(255,199,44,0.35)' }}>
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: '#FFC72C' }} />
                      <h4 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {ev.title}
                      </h4>
                      <span className="text-xs px-1.5 py-0.5 rounded-full"
                            style={{ background: 'rgba(255,199,44,0.1)', color: '#a16207', border: '1px solid rgba(255,199,44,0.25)' }}>
                        awaiting votes
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {fmtEventTime(ev.date) && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5" style={{ color: 'var(--text-subtle)' }} />
                          {fmtEventTime(ev.date)}
                        </span>
                      )}
                      {ev.location && (
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3.5 h-3.5" style={{ color: 'var(--text-subtle)' }} />
                          {ev.location}
                        </span>
                      )}
                      {ev.proposerName && (
                        <span style={{ color: 'var(--text-subtle)' }}>proposed by @{ev.proposerName}</span>
                      )}
                    </div>
                    <p className="text-xs mt-1.5" style={{ color: 'var(--text-subtle)' }}>
                      Vote on it in the “Proposals awaiting votes” section below the calendar.
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Event Creation Dialog */}
      {showEventDialog && session && (
        <EventDialog
          session={session}
          onClose={() => setShowEventDialog(false)}
          onEventCreated={() => { loadEvents(); }}
        />
      )}
      
      {!session && showEventDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
          <div className="w-full max-w-md p-6 rounded-xl text-center" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
            <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
              Please Login First
            </h3>
            <p className="text-sm text-gray-400 mb-4">
              You must be logged in to propose events.
            </p>
            <div className="flex flex-col sm:flex-row gap-2 justify-center">
              <button
                onClick={() => { setShowEventDialog(false); setCurrentView('chat'); }}
                className="px-4 py-2 rounded text-sm font-medium transition-colors"
                style={{ background: '#16a34a', color: '#fff' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#15803d'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#16a34a'; }}>
                Sign In
              </button>
              <button
                onClick={() => setShowEventDialog(false)}
                className="px-4 py-2 rounded text-sm transition-colors"
                style={{ border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
