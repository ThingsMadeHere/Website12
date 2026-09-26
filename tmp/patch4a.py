import re, sys

PATH = '/workspace/api/index.js'
src = open(PATH).read()

def rep(old, new):
    global src
    assert src.count(old) == 1, f"NOT UNIQUE/FOUND ({src.count(old)}): {old[:70]}"
    src = src.replace(old, new, 1)

# ── notification settings: zod (regex to be whitespace-robust) ──
pat = re.compile(
r"""app\.put\('/api/me/notification-settings', requireAuth, \(req, res\) => \{.*?res\.json\(\{ ok: true, notificationSettings: settings \}\);\n\}""",
re.S)
assert len(pat.findall(src)) == 1, "notif pattern"
src = pat.sub(
"""app.put('/api/me/notification-settings', requireAuth, (req, res) => {
  const [data,] = validate(NotificationSettingsSchema, req, res);
  if (!data) return;

  db.prepare('UPDATE users SET notification_settings = ? WHERE id = ?').run(data.settings, req.user.id);
  res.json({ ok: true, notificationSettings: data.settings });
}""", src, count=1)

# ── profile PUT: zod ──
rep("""app.put('/api/profile', requireAuth, blockIfTimedOut, (req, res) => {
  const { fullName } = req.body || {};
  if (!fullName || String(fullName).trim().length === 0) {
    return res.status(400).json({ error: 'Full name is required' });
  }
  db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(String(fullName).trim().slice(0, 80), req.user.id);
  res.json({ ok: true });""",
"""app.put('/api/profile', requireAuth, blockIfTimedOut, (req, res) => {
  const [data,] = validate(ProfileSchema, req, res);
  if (!data) return;
  db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(data.fullName, req.user.id);
  res.json({ ok: true });""")

open(PATH, 'w').write(src)
print('part4a applied')
