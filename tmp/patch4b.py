import re

PATH = '/workspace/api/index.js'
src = open(PATH).read()

def count(pat, flags=re.S):
    return len(re.findall(pat, src, flags))

# ── profile photo POST: zod + decodePhoto helper ──
pat = re.compile(
r"""app\.post\('/api/profile/photo', requireAuth, blockIfTimedOut, \(req, res\) => \{.*?db\.prepare\('UPDATE users SET photo = \?, photo_mime = \? WHERE id = \?'\)\.run\(buf, mime, req\.user\.id\);\n  res\.json\(\{ ok: true \}\);""",
re.S)
assert count(pat) == 1, f"photo pattern count={count(pat)}"
src = pat.sub(
r"""app.post('/api/profile/photo', requireAuth, blockIfTimedOut, (req, res) => {
  const [data,] = validate(ProfilePhotoSchema, req, res);
  if (!data) return;

  const p = decodePhoto(data.photo);
  if (p.error) return res.status(400).json({ error: p.error });

  db.prepare('UPDATE users SET photo = ?, photo_mime = ? WHERE id = ?').run(p.buf, p.mime, req.user.id);
  res.json({ ok: true });""", src, count=1)

# ── channels POST: zod ──
pat = re.compile(
r"""app\.post\('/api/channels', requireAuth, blockIfTimedOut, \(req, res\) => \{.*?res\.json\(\{ id: info\.lastInsertRowid, name, description: \(req\.body \|\| \{\}\)\.description \|\| '' \}\);""",
re.S)
assert count(pat) == 1, f"channels pattern count={count(pat)}"
src = pat.sub(
r"""app.post('/api/channels', requireAuth, blockIfTimedOut, (req, res) => {
  const [data,] = validate(ChannelSchema, req, res);
  if (!data) return;

  const name = slugifyChannelName(data.name);
  if (name.length < 2)
    return res.status(400).json({ error: 'Channel name must be at least 2 characters (letters/numbers only)' });

  const exists = db.prepare('SELECT id FROM channels WHERE name = ?').get(name);
  if (exists) return res.status(409).json({ error: `#${name} already exists` });

  const info = db
    .prepare('INSERT INTO channels (name, description) VALUES (?, ?)')
    .run(name, data.description);
  res.json({ id: info.lastInsertRowid, name, description: data.description });""", src, count=1)

# ── messages POST: zod + rate limit ──
pat = re.compile(
r"""app\.post\('/api/channels/:id/messages', requireAuth, blockIfTimedOut, \(req, res\) => \{(.+?)const body = String\(\(req\.body \|\| \{\}\)\.body \|\| ''\)\.trim\(\)\.slice\(0, 2000\);\n  if \(!body\) return res\.status\(400\)\.json\(\{ error: 'Message is empty' \}\);""",
re.S)
assert count(pat) == 1, f"messages pattern count={count(pat)}"
src = pat.sub(
r"""app.post('/api/channels/:id/messages', requireAuth, blockIfTimedOut, messageLimiter, (req, res) => {\1const [msgData,] = validate(MessageSchema, req, res);
  if (!msgData) return;
  const body = msgData.body;""", src, count=1)

# ── availability POST: zod ──
pat = re.compile(
r"""  const \{ title, date, startTime, endTime, location, repeatType \} = req\.body \|\| \{\};\n\n  if \(!date\) \{\n    return res\.status\(400\)\.json\(\{ error: 'Date is required' \}\);\n  \}""",
re.S)
assert count(pat) == 1, f"avail pattern count={count(pat)}"
src = pat.sub(
r"""  const [data,] = validate(AvailabilitySchema, req, res);
  if (!data) return;""", src, count=1)

pat = re.compile(
r"""  const info = insert\.run\(\n    req\.user\.id,\n    title \|\| null,\n    date,\n    startTime \|\| null,\n    endTime \|\| null,\n    location \|\| null,\n    repeatType \|\| 'none'\n  \);""",
re.S)
assert count(pat) == 1, f"avail insert pattern count={count(pat)}"
src = pat.sub(
r"""  const info = insert.run(
    req.user.id,
    data.title || null,
    data.date,
    data.startTime || null,
    data.endTime || null,
    data.location || null,
    data.repeatType
  );""", src, count=1)

open(PATH, 'w').write(src)
print('part4b applied')
