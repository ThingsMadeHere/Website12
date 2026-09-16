// ── role tags ────────────────────────────────────────────────────────────────
// Members can carry free-form tags (mentor, lead, alumni, …). Colors are
// deterministic so a tag looks the same everywhere on the site.
// Tuned for the light theme: deep readable text colors on soft washes.
// Palette leads with the school colors: admin = gold, mentor = green.

export const SUGGESTED_TAGS = [
  'admin', 'mentor', 'lead', 'captain', 'alumni',
  'programming', 'build', 'driver', 'rookie',
];

const PALETTE = [
  { color: '#a16207', bg: 'rgba(255,199,44,0.22)', border: 'rgba(161,98,7,0.35)' },  // school gold
  { color: '#166534', bg: 'rgba(22,163,74,0.12)',  border: 'rgba(22,163,74,0.32)' }, // school green
  { color: '#92400e', bg: 'rgba(217,160,102,0.16)', border: 'rgba(146,64,14,0.30)' }, // bronze
  { color: '#4d7c0f', bg: 'rgba(132,204,22,0.12)', border: 'rgba(77,124,15,0.30)' },  // olive
  { color: '#0f766e', bg: 'rgba(20,184,166,0.10)', border: 'rgba(15,118,110,0.30)' }, // teal
  { color: '#a21caf', bg: 'rgba(217,70,239,0.08)', border: 'rgba(162,28,175,0.28)' }, // orchid
  { color: '#b91c1c', bg: 'rgba(248,113,113,0.10)', border: 'rgba(185,28,28,0.28)' }, // clay
];

export function tagColor(tag) {
  const t = String(tag || '').toLowerCase();
  if (t === 'admin')  return PALETTE[0]; // always gold — matches the ADMIN badge
  if (t === 'mentor') return PALETTE[1]; // always green
  let h = 0;
  for (let i = 0; i < t.length; i++) h = t.charCodeAt(i) + ((h << 5) - h);
  return PALETTE[Math.abs(h) % PALETTE.length];
}
