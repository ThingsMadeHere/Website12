import { useState, useEffect, useCallback } from 'react';
import { User, Upload, Calendar, Clock, MapPin, Trash2, Plus, X as XIcon, ChevronLeft, ChevronRight } from 'lucide-react';

const fmtBlockDate = (d) => {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return d;
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};

const fmtBlockTime = (dateStr) => {
  if (!String(dateStr).includes('T')) return null;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export default function ProfilePage({ session, setCurrentView }) {
  const [user, setUser] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [availabilityBlocks, setAvailabilityBlocks] = useState([]);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [showAddBlock, setShowAddBlock] = useState(false);
  const [newBlock, setNewBlock] = useState({
    title: '',
    startTime: '',
    endTime: '',
    location: '',
    repeatType: 'none', // none, weekly, monthly
    date: new Date().toISOString().split('T')[0],
  });
  const [isLoading, setIsLoading] = useState(true);

  // Load user profile
  const loadProfile = useCallback(async () => {
    if (!session?.token) return;
    try {
      const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${session.token}` } });
      if (res.ok) {
        const data = await res.json();
        setUser(data);
      }
    } catch (err) {
      console.error('Error loading profile:', err);
    }
  }, [session]);

  // Load availability blocks
  const loadAvailability = useCallback(async () => {
    if (!session?.token) return;
    try {
      const res = await fetch('/api/availability', { headers: { Authorization: `Bearer ${session.token}` } });
      if (res.ok) {
        const data = await res.json();
        setAvailabilityBlocks(data);
      }
    } catch (err) {
      console.error('Error loading availability:', err);
    } finally {
      setIsLoading(false);
    }
  }, [session]);

  useEffect(() => {
    loadProfile();
    loadAvailability();
  }, [loadProfile, loadAvailability]);

  // Handle photo selection
  const handlePhotoSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      setSelectedFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setPhotoPreview(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  // Handle photo upload
  const handlePhotoUpload = async () => {
    if (!selectedFile || !session?.token) return;
    
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('photo', selectedFile);
      
      const res = await fetch('/api/profile/photo', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}` },
        body: formData,
      });
      
      if (res.ok) {
        await loadProfile();
        setSelectedFile(null);
        setPhotoPreview(null);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to upload photo');
      }
    } catch (err) {
      console.error('Error uploading photo:', err);
      alert('Failed to upload photo');
    } finally {
      setIsUploading(false);
    }
  };

  // Handle profile update
  const handleProfileUpdate = async (e) => {
    e.preventDefault();
    if (!session?.token) return;
    
    const fullName = e.target.fullName.value;
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}` 
        },
        body: JSON.stringify({ fullName }),
      });
      
      if (res.ok) {
        await loadProfile();
        alert('Profile updated successfully!');
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to update profile');
      }
    } catch (err) {
      console.error('Error updating profile:', err);
      alert('Failed to update profile');
    }
  };

  // Handle add availability block
  const handleAddBlock = async (e) => {
    e.preventDefault();
    if (!session?.token) return;
    
    try {
      const res = await fetch('/api/availability', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}` 
        },
        body: JSON.stringify({
          ...newBlock,
          startTime: newBlock.startTime || '09:00',
          endTime: newBlock.endTime || '17:00',
        }),
      });
      
      if (res.ok) {
        await loadAvailability();
        setShowAddBlock(false);
        setNewBlock({
          title: '',
          startTime: '',
          endTime: '',
          location: '',
          repeatType: 'none',
          date: new Date().toISOString().split('T')[0],
        });
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to add availability block');
      }
    } catch (err) {
      console.error('Error adding availability:', err);
      alert('Failed to add availability block');
    }
  };

  // Handle delete availability block
  const handleDeleteBlock = async (blockId) => {
    if (!window.confirm('Delete this availability block?')) return;
    if (!session?.token) return;
    
    try {
      const res = await fetch(`/api/availability/${blockId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.token}` },
      });
      
      if (res.ok) {
        await loadAvailability();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to delete availability block');
      }
    } catch (err) {
      console.error('Error deleting availability:', err);
      alert('Failed to delete availability block');
    }
  };

  // Calendar helpers
  const formatMonthYear = (date) => {
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  const getDaysInMonth = (date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  };

  const getFirstDayOfMonth = (date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  };

  const getBlocksForDay = (date) => {
    return availabilityBlocks.filter(block => {
      const blockDate = new Date(block.date);
      if (block.repeatType === 'weekly') {
        return blockDate.getDay() === date.getDay();
      } else if (block.repeatType === 'monthly') {
        return blockDate.getDate() === date.getDate();
      } else {
        return blockDate.getDate() === date.getDate() && 
               blockDate.getMonth() === date.getMonth() && 
               blockDate.getFullYear() === date.getFullYear();
      }
    });
  };

  const daysInMonth = getDaysInMonth(currentMonth);
  const firstDay = getFirstDayOfMonth(currentMonth);

  const calendarDays = [];
  for (let i = 0; i < firstDay; i++) {
    calendarDays.push(null);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    calendarDays.push(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day));
  }

  const getRepeatLabel = (type) => {
    switch (type) {
      case 'weekly': return 'Every week';
      case 'monthly': return 'Every month';
      default: return 'One-time';
    }
  };

  if (!session) {
    return (
      <div className="min-h-screen py-8 sm:py-16 px-3 sm:px-6 flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Please sign in</h2>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>You need to be signed in to view your profile.</p>
          <button
            onClick={() => setCurrentView('chat')}
            className="px-4 py-2 rounded-lg text-sm font-medium"
            style={{ background: '#16a34a', color: '#fff' }}
          >
            Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen py-8 sm:py-16 px-3 sm:px-6" style={{ background: 'var(--bg-base)' }}>
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <p className="text-xs font-medium uppercase tracking-widest mb-3" style={{ color: 'var(--text-subtle)' }}>
            Account
          </p>
          <h1 className="text-2xl font-semibold mb-2" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            My Profile
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Manage your profile information and availability.
          </p>
        </div>

        {/* Profile Section */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          {/* Photo Upload */}
          <div className="md:col-span-1 p-4 sm:p-6 rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
            <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Profile Picture</h2>
            
            <div className="flex flex-col items-center">
              <div className="w-24 h-24 rounded-full overflow-hidden mb-4 bg-gray-700 flex items-center justify-center">
                {photoPreview || user?.photo ? (
                  <img 
                    src={photoPreview || `data:${user?.photo_mime || 'image/png'};base64,${user?.photo}`} 
                    alt="Profile" 
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <User className="w-12 h-12 text-gray-500" />
                )}
              </div>
              
              <label className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors mb-2"
                     style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                     onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-subtle)'; }}
                     onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}>
                <Upload className="w-4 h-4" />
                Choose File
                <input type="file" accept="image/*" onChange={handlePhotoSelect} className="hidden" />
              </label>
              
              {selectedFile && (
                <button
                  onClick={handlePhotoUpload}
                  disabled={isUploading}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors w-full justify-center"
                  style={{ background: isUploading ? '#15803d' : '#16a34a', color: '#fff' }}
                  onMouseEnter={e => { if (!isUploading) e.currentTarget.style.background = '#15803d'; }}
                  onMouseLeave={e => { if (!isUploading) e.currentTarget.style.background = '#16a34a'; }}
                >
                  {isUploading ? 'Uploading...' : 'Upload Photo'}
                </button>
              )}
            </div>
          </div>

          {/* Profile Info Form */}
          <div className="md:col-span-2 p-4 sm:p-6 rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
            <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Profile Information</h2>
            
            <form onSubmit={handleProfileUpdate} className="space-y-4">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-subtle)' }}>Username</label>
                <input
                  type="text"
                  value={user?.username || ''}
                  disabled
                  className="w-full px-3 py-2 rounded-lg text-sm bg-transparent border"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                />
              </div>
              
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-subtle)' }}>Full Name</label>
                <input
                  type="text"
                  name="fullName"
                  defaultValue={user?.full_name || ''}
                  placeholder="Enter your full name"
                  className="w-full px-3 py-2 rounded-lg text-sm bg-transparent border focus:outline-none focus:ring-2 focus:ring-green-600"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                />
              </div>
              
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-subtle)' }}>Email Status</label>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-1 rounded ${user?.verified ? 'bg-green-900/30 text-green-400 border border-green-700' : 'bg-yellow-900/30 text-yellow-400 border border-yellow-700'}`}>
                    {user?.verified ? 'Verified' : 'Pending Verification'}
                  </span>
                </div>
              </div>

              <button
                type="submit"
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ background: '#16a34a', color: '#fff' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#15803d'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#16a34a'; }}
              >
                Save Changes
              </button>
            </form>
          </div>
        </div>

        {/* Availability Calendar Section */}
        <div className="p-4 sm:p-6 rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <div>
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>My Availability</h2>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Block out times when you're available. Set blocks to repeat weekly or monthly.
              </p>
            </div>
            <button
              onClick={() => setShowAddBlock(true)}
              className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{ background: '#16a34a', color: '#fff' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#15803d'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#16a34a'; }}
            >
              <Plus className="w-4 h-4" />
              Add Availability
            </button>
          </div>

          {/* Calendar */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {formatMonthYear(currentMonth)}
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))}
                  className="p-2 rounded-lg transition-colors"
                  style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-subtle)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                >
                  <ChevronLeft className="w-4 h-4" style={{ color: 'var(--text-primary)' }} />
                </button>
                <button
                  onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))}
                  className="p-2 rounded-lg transition-colors"
                  style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-subtle)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                >
                  <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-primary)' }} />
                </button>
              </div>
            </div>

            {/* Weekdays */}
            <div className="grid grid-cols-7 mb-2">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                <div key={day} className="text-center text-xs font-medium" style={{ color: 'var(--text-subtle)' }}>
                  {day}
                </div>
              ))}
            </div>

            {/* Days Grid */}
            <div className="grid grid-cols-7 gap-1">
              {isLoading ? (
                <div className="col-span-7 py-8 text-center" style={{ color: 'var(--text-subtle)' }}>
                  Loading availability...
                </div>
              ) : (
                calendarDays.map((day, i) => {
                  if (!day) {
                    return <div key={i} className="aspect-square" />;
                  }

                  const dayBlocks = getBlocksForDay(day);
                  const isToday = day.getDate() === new Date().getDate() &&
                                  day.getMonth() === new Date().getMonth() &&
                                  day.getFullYear() === new Date().getFullYear();

                  return (
                    <div key={i}
                         className={`aspect-square rounded-lg p-1 relative transition-colors ${isToday ? 'ring-1 ring-green-500' : ''}`}
                         style={{ background: 'var(--bg-base)' }}>
                      <span className="text-xs font-medium"
                            style={{ color: isToday ? 'var(--gold)' : 'var(--text-primary)' }}>
                        {day.getDate()}
                      </span>
                      {dayBlocks.length > 0 && (
                        <div className="flex flex-wrap gap-0.5 mt-1">
                          {dayBlocks.slice(0, 4).map((block, idx) => (
                            <div key={idx} className="w-1.5 h-1.5 rounded-full" style={{ background: '#3b82f6' }} />
                          ))}
                          {dayBlocks.length > 4 && (
                            <span className="text-[8px] leading-none" style={{ color: 'var(--text-subtle)' }}>
                              +{dayBlocks.length - 4}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Availability Blocks List */}
          {availabilityBlocks.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>
                Your Availability Blocks
              </h3>
              <div className="space-y-2">
                {availabilityBlocks.map(block => (
                  <div key={block.id} 
                       className="p-3 rounded-lg flex items-center justify-between"
                       style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}>
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: 'rgba(59,130,246,0.15)' }}>
                        <Calendar className="w-4 h-4" style={{ color: '#3b82f6' }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                            {block.title || 'Available'}
                          </span>
                          {block.repeatType !== 'none' && (
                            <span className="text-xs px-1.5 py-0.5 rounded"
                                  style={{ background: 'rgba(59,130,246,0.15)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.3)' }}>
                              {getRepeatLabel(block.repeatType)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {fmtBlockTime(block.start_time)} - {fmtBlockTime(block.end_time)}
                          </span>
                          {block.location && (
                            <span className="flex items-center gap-1">
                              <MapPin className="w-3 h-3" />
                              {block.location}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteBlock(block.id)}
                      className="p-2 rounded-lg transition-colors shrink-0"
                      style={{ color: 'var(--text-muted)' }}
                      onMouseEnter={e => { e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.background = 'rgba(239,68,68,0.1)'; }}
                      onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {availabilityBlocks.length === 0 && !isLoading && (
            <div className="text-center py-8">
              <Calendar className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--text-subtle)' }} />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No availability blocks yet. Add one to get started!</p>
            </div>
          )}
        </div>
      </div>

      {/* Add Availability Modal */}
      {showAddBlock && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             onClick={() => setShowAddBlock(false)}>
          <div className="w-full max-w-md rounded-xl p-6"
               style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
               onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Add Availability Block</h3>
              <button
                onClick={() => setShowAddBlock(false)}
                className="p-2 rounded-lg transition-colors"
                style={{ color: 'var(--text-muted)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-base)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <XIcon className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddBlock} className="space-y-4">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-subtle)' }}>Title (optional)</label>
                <input
                  type="text"
                  value={newBlock.title}
                  onChange={e => setNewBlock({ ...newBlock, title: e.target.value })}
                  placeholder="e.g., Available for tutoring"
                  className="w-full px-3 py-2 rounded-lg text-sm bg-transparent border focus:outline-none focus:ring-2 focus:ring-green-600"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-subtle)' }}>Date</label>
                <input
                  type="date"
                  value={newBlock.date}
                  onChange={e => setNewBlock({ ...newBlock, date: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg text-sm bg-transparent border focus:outline-none focus:ring-2 focus:ring-green-600"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-subtle)' }}>Start Time</label>
                  <input
                    type="time"
                    value={newBlock.startTime}
                    onChange={e => setNewBlock({ ...newBlock, startTime: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg text-sm bg-transparent border focus:outline-none focus:ring-2 focus:ring-green-600"
                    style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-subtle)' }}>End Time</label>
                  <input
                    type="time"
                    value={newBlock.endTime}
                    onChange={e => setNewBlock({ ...newBlock, endTime: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg text-sm bg-transparent border focus:outline-none focus:ring-2 focus:ring-green-600"
                    style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-subtle)' }}>Location (optional)</label>
                <input
                  type="text"
                  value={newBlock.location}
                  onChange={e => setNewBlock({ ...newBlock, location: e.target.value })}
                  placeholder="e.g., Library, Room 101"
                  className="w-full px-3 py-2 rounded-lg text-sm bg-transparent border focus:outline-none focus:ring-2 focus:ring-green-600"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-subtle)' }}>Repeat</label>
                <select
                  value={newBlock.repeatType}
                  onChange={e => setNewBlock({ ...newBlock, repeatType: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg text-sm bg-transparent border focus:outline-none focus:ring-2 focus:ring-green-600"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                >
                  <option value="none">One-time</option>
                  <option value="weekly">Every week</option>
                  <option value="monthly">Every month</option>
                </select>
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowAddBlock(false)}
                  className="flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-subtle)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: '#16a34a', color: '#fff' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#15803d'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#16a34a'; }}
                >
                  Add Block
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
