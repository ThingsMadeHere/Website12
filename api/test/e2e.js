// E2E tests for the API (admin management, tags, timeouts, forced password
// resets, applications, auth). Runs against a live server:
//
//   DATABASE_PATH=/tmp/test.db PORT=3101 node index.js &      # start server
//   DATABASE_PATH=/tmp/test.db node test/seed-admin.js        # seed @testadmin
//   TEST_BASE_URL=http://localhost:3101 node test/e2e.js      # run tests
//
// CI runs exactly this sequence (.github/workflows/ci.yml).
// The database should be FRESH — the suite creates its own users.
'use strict';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3101';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

async function j(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data };
}

const fakePhoto = { mime: 'image/png', data: Buffer.alloc(200, 7).toString('base64') };

async function main() {
  console.log('── 1. admin login ──');
  let r = await j('POST', '/api/login', { username: 'testadmin', password: 'adminpass123' });
  ok('admin login ok', r.status === 200 && !!r.data.token, JSON.stringify(r.data));
  const adminTok = r.data.token;
  ok('admin flag + tags in login', r.data.admin === true && r.data.tags.includes('admin'));

  console.log('── 2. admin users list ──');
  r = await j('GET', '/api/admin/users', null, adminTok);
  ok('list users', r.status === 200 && Array.isArray(r.data) && r.data.some(u => u.username === 'testadmin'));

  console.log('── 3. application → approval copies name+photo ──');
  r = await j('POST', '/api/applications', { username: 'alice', fullName: 'Alice Applicant', photo: fakePhoto });
  ok('application submitted', (r.status === 200 || r.status === 201) && r.data.status === 'pending', JSON.stringify(r.data));
  const appId = r.data.applicationId;
  r = await j('POST', `/api/applications/${appId}/decision`, { action: 'approve' }, adminTok);
  ok('approve application', r.status === 200 && r.data.status === 'approved');
  const aliceId = r.data.userId;
  r = await j('GET', '/api/admin/users', null, adminTok);
  const alice = r.data.find(u => u.id === aliceId);
  ok('approval copied full name', alice && alice.fullName === 'Alice Applicant', JSON.stringify(alice));
  ok('approval copied photo', alice && alice.hasPhoto === true);
  const pres = await fetch(`${BASE}/api/users/${aliceId}/photo`, { headers: { Authorization: `Bearer ${adminTok}` } });
  const pbuf = Buffer.from(await pres.arrayBuffer());
  ok('photo endpoint serves bytes', pres.status === 200 && pbuf.length === 200 && pbuf[0] === 7, `status=${pres.status} len=${pbuf.length}`);

  console.log('── 4. member cannot use admin endpoints ──');
  r = await j('POST', '/api/login', { username: 'alice', password: 'wonderland1' });
  ok('member login', r.status === 200 && !!r.data.token && r.data.admin === false);
  const aliceTok = r.data.token;
  r = await j('GET', '/api/admin/users', null, aliceTok);
  ok('member blocked from admin list (403)', r.status === 403);
  r = await j('POST', '/api/admin/users', { username: 'x', password: 'yyyyyy' }, aliceTok);
  ok('member blocked from creating accounts (403)', r.status === 403);
  const selfPhoto = await fetch(`${BASE}/api/users/${aliceId}/photo`, { headers: { Authorization: `Bearer ${aliceTok}` } });
  ok('member can fetch own photo', selfPhoto.status === 200);

  console.log('── 5. tags ──');
  r = await j('PUT', `/api/admin/users/${aliceId}/tags`, { tags: ['Mentor', 'build'] }, adminTok);
  ok('set tags (normalized+sorted)', r.status === 200 && JSON.stringify(r.data.tags) === JSON.stringify(['build', 'mentor']), JSON.stringify(r.data.tags));
  ok('tags do not grant admin', r.data.admin === false);
  r = await j('PUT', `/api/admin/users/${aliceId}/tags`, { tags: ['admin', 'mentor'] }, adminTok);
  ok('admin tag promotes', r.status === 200 && r.data.admin === true);
  r = await j('PUT', `/api/admin/users/${aliceId}/tags`, { tags: ['mentor'] }, adminTok);
  ok('removing admin tag demotes', r.status === 200 && r.data.admin === false);
  const me = await j('GET', '/api/admin/users', null, adminTok);
  const adminId = me.data.find(u => u.username === 'testadmin').id;
  r = await j('PUT', `/api/admin/users/${adminId}/tags`, { tags: [] }, adminTok);
  ok('cannot remove own admin tag (400)', r.status === 400, JSON.stringify(r.data));
  r = await j('PUT', `/api/admin/users/${aliceId}/tags`, { tags: ['BAD TAG!!'] }, adminTok);
  ok('invalid tag rejected (400)', r.status === 400);
  await j('PUT', `/api/admin/users/${aliceId}/tags`, { tags: ['mentor'] }, adminTok);

  console.log('── 6. messages carry tags + photo flag ──');
  r = await j('GET', '/api/channels', null, aliceTok);
  const chan = r.data[0].id;
  r = await j('POST', `/api/channels/${chan}/messages`, { body: 'hello from alice' }, aliceTok);
  ok('member posts message', r.status === 200 && r.data.body === 'hello from alice');
  ok('message row has tags + hasPhoto', JSON.stringify(r.data.tags) === JSON.stringify(['mentor']) && r.data.hasPhoto === true, JSON.stringify(r.data));

  console.log('── 7. timeouts ──');
  r = await j('POST', `/api/admin/users/${aliceId}/timeout`, { minutes: 10 }, adminTok);
  ok('timeout applied', r.status === 200 && !!r.data.timeoutUntil, JSON.stringify(r.data));
  r = await j('POST', `/api/channels/${chan}/messages`, { body: 'can I post?' }, aliceTok);
  ok('timed-out member cannot post (403 + code)', r.status === 403 && r.data.code === 'timeout', JSON.stringify(r.data));
  r = await j('GET', `/api/channels/${chan}/messages`, null, aliceTok);
  ok('timed-out member can still read', r.status === 200);
  r = await j('GET', '/api/events');
  const evId = r.data[0].id;
  r = await j('POST', `/api/events/${evId}/vote`, { vote: 1 }, aliceTok);
  ok('timed-out member cannot vote (403)', r.status === 403);
  r = await j('POST', '/api/events', { title: 'x', date: '2026-12-01T10:00:00' }, aliceTok);
  ok('timed-out member cannot propose events (403)', r.status === 403);
  r = await j('GET', '/api/me', null, aliceTok);
  ok('/api/me reports timeoutUntil + tags', r.status === 200 && !!r.data.timeoutUntil && JSON.stringify(r.data.tags) === JSON.stringify(['mentor']));
  r = await j('POST', `/api/admin/users/${adminId}/timeout`, { minutes: 5 }, adminTok);
  ok('cannot time self out (400)', r.status === 400);
  r = await j('POST', `/api/admin/users/${aliceId}/timeout`, { minutes: -5 }, adminTok);
  ok('negative minutes rejected (400)', r.status === 400);
  r = await j('POST', `/api/admin/users/${aliceId}/timeout`, { until: '2020-01-01T00:00:00.000Z' }, adminTok);
  ok('past until rejected (400)', r.status === 400);
  r = await j('POST', `/api/admin/users/${aliceId}/timeout`, { clear: true }, adminTok);
  ok('timeout cleared', r.status === 200 && r.data.timeoutUntil === null);
  r = await j('POST', `/api/channels/${chan}/messages`, { body: 'free again!' }, aliceTok);
  ok('posting works after clear', r.status === 200);

  console.log('── 8. create account + forced password reset ──');
  r = await j('POST', '/api/admin/users', { username: 'BOBB', password: 'temppass123', fullName: 'Bob Builder', tags: ['admin'], verified: true, mustChangePassword: true, photo: fakePhoto }, adminTok);
  ok('admin creates account', r.status === 200 && r.data.username === 'bobb' && r.data.admin === true && r.data.mustChangePassword === true, JSON.stringify(r.data));
  const bobbId = r.data.id;
  r = await j('POST', '/api/admin/users', { username: 'bobb', password: 'temppass123' }, adminTok);
  ok('duplicate username rejected (409)', r.status === 409);
  r = await j('POST', '/api/admin/users', { username: 'shorty', password: '123' }, adminTok);
  ok('short password rejected (400)', r.status === 400);
  r = await j('POST', '/api/login', { username: 'bobb', password: 'temppass123' });
  ok('flagged login → mustChangePassword, no token', r.status === 200 && r.data.mustChangePassword === true && !r.data.token, JSON.stringify(r.data));
  r = await j('POST', '/api/password/reset', { username: 'bobb', currentPassword: 'wrongpass', newPassword: 'brandnew123' });
  ok('reset with wrong current password (401)', r.status === 401);
  r = await j('POST', '/api/password/reset', { username: 'bobb', currentPassword: 'temppass123', newPassword: 'abc' });
  ok('reset with short new password (400)', r.status === 400);
  r = await j('POST', '/api/password/reset', { username: 'bobb', currentPassword: 'temppass123', newPassword: 'temppass123' });
  ok('reset to same password (400)', r.status === 400);
  r = await j('POST', '/api/password/reset', { username: 'bobb', currentPassword: 'temppass123', newPassword: 'brandnew123' });
  ok('reset succeeds → full session', r.status === 200 && !!r.data.token && r.data.admin === true && r.data.fullName === 'Bob Builder', JSON.stringify(r.data));
  r = await j('POST', '/api/login', { username: 'bobb', password: 'brandnew123' });
  ok('login with new password works', r.status === 200 && !!r.data.token && !r.data.mustChangePassword);
  r = await j('POST', '/api/password/reset', { username: 'bobb', currentPassword: 'brandnew123', newPassword: 'another123' });
  ok('reset rejected when flag cleared (403)', r.status === 403);

  console.log('── 9. patch account info ──');
  r = await j('PATCH', `/api/admin/users/${bobbId}`, { fullName: 'Robert Builder', verified: false, photo: null }, adminTok);
  ok('patch name/verified/remove photo', r.status === 200 && r.data.fullName === 'Robert Builder' && r.data.verified === false && r.data.hasPhoto === false, JSON.stringify(r.data));
  r = await j('PATCH', `/api/admin/users/${bobbId}`, { username: 'robertb' }, adminTok);
  ok('patch username', r.status === 200 && r.data.username === 'robertb');
  r = await j('POST', '/api/login', { username: 'robertb', password: 'brandnew123' });
  ok('login with renamed username', r.status === 200 && !!r.data.token);
  r = await j('PATCH', `/api/admin/users/${bobbId}`, { username: 'alice' }, adminTok);
  ok('rename to taken username rejected (409)', r.status === 409);
  r = await j('PATCH', `/api/admin/users/${bobbId}`, { password: 'rotated999', mustChangePassword: true }, adminTok);
  ok('admin sets password + re-flags reset', r.status === 200 && r.data.mustChangePassword === true);
  r = await j('POST', '/api/login', { username: 'robertb', password: 'brandnew123' });
  ok('old password rejected after rotation (401)', r.status === 401, JSON.stringify(r.data));
  r = await j('POST', '/api/login', { username: 'robertb', password: 'rotated999' });
  ok('new password → forced reset prompt, no token', r.status === 200 && r.data.mustChangePassword === true && !r.data.token, JSON.stringify(r.data));

  console.log('── 10. pending application auto-denied when admin creates same username ──');
  r = await j('POST', '/api/applications', { username: "carol", fullName: "Carol C", photo: fakePhoto });
  ok('carol applied', r.status === 200);
  const carolAppId = r.data.applicationId;
  r = await j('POST', '/api/admin/users', { username: 'carol', password: 'caroltemp1' }, adminTok);
  ok('admin created carol directly', r.status === 200);
  r = await j('GET', '/api/applications?status=all', null, adminTok);
  const carolApp = r.data.find(a => a.id === carolAppId);
  ok('pending application auto-denied', carolApp && carolApp.status === 'denied', JSON.stringify(carolApp));

  console.log('── 11. /api/verify now admin-only ──');
  r = await j('POST', '/api/verify', null, aliceTok);
  ok('member cannot self-verify (403)', r.status === 403);

  console.log('── 12. bad session ──');
  r = await j('GET', '/api/me', null, 'bogus-token');
  ok('/api/me with bad token (401)', r.status === 401);

  console.log('── 13. team-key self-service sign-in (no admin per login) ──');
  // Seeded by test/seed-admin.js when TEAM_KEY is set (scripts/pm2-test.sh does this).
  const TESTKEY = process.env.TEST_TEAM_KEY || 'ROBO-KEY-TEST';
  let keyActive = false;
  r = await j('POST', '/api/admin/join-key', { key: TESTKEY, label: 'e2e' }, adminTok);
  if (r.status === 200) {
    keyActive = true;
    ok('admin can set/rotate the team key', r.data.ok === true && !!r.data.expiresAt);
  } else {
    // key already seeded via TEAM_KEY env — rotation would change it, so skip writes
    console.log(`  NOTE  join-key endpoint returned ${r.status} — using pre-seeded key`);
    const probe = await j('POST', '/api/login/join', { username: 'zzprobe', key: TESTKEY });
    keyActive = probe.status === 200;
  }
  if (!keyActive) {
    console.log('  SKIP  team key not active — run via scripts/pm2-test.sh to cover join flow');
  } else {
    r = await j('POST', '/api/login/join', { username: 'dave', key: TESTKEY });
    ok('join with correct key creates account + session', r.status === 200 && !!r.data.token, JSON.stringify(r.data));
    r = await j('POST', '/api/login/join', { username: 'dave', key: TESTKEY });
    ok('same key signs the account back in', r.status === 200 && !!r.data.token);
    r = await j('POST', '/api/login/join', { username: 'erin', key: 'WRONG-KEY-999' });
    ok('wrong key for new username → application path', r.status === 403 && r.data.code === 'apply', JSON.stringify(r.data));
    r = await j('POST', '/api/login/join', { username: 'dave', key: 'WRONG-KEY-999' });
    ok('wrong key on existing account rejected (401)', r.status === 401, JSON.stringify(r.data));
    r = await j('POST', '/api/login/join', { username: 'ab', key: TESTKEY });
    ok('invalid username rejected', r.status === 401 || r.status === 403, JSON.stringify(r.data));
    const daveLogin = await j('POST', '/api/login/join', { username: 'dave', key: TESTKEY });
    r = await j('GET', '/api/admin/users', null, daveLogin.data.token);
    ok('key-joined user has no admin access (403)', r.status === 403);
    r = await j('POST', '/api/login', { username: 'dave', password: 'anything' });
    ok('join-key accounts have no usable password (401)', r.status === 401);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
