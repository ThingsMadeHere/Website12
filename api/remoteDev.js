// ── Remote development workspace API ─────────────────────────────────────────
// A browser-based editor + build pipeline for FRC code. Designed for clients on
// locked-down school Chromebooks: everything happens over plain HTTPS against
// this same origin (/api/remote-dev/*) — no SSH client, no WebSocket terminal,
// no extensions required. The server executes nothing from user input; builds
// run inside an isolated compiler container that polls a job queue.
//
// Storage layout (shared docker volume `wplib_workspaces`):
//   <WORKSPACES_ROOT>/<username>/          ← each user's private workspace
//   <COMPILER_OUTPUT_DIR>/<jobId>_<ts>/    ← build logs + artifacts
'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const WORKSPACES_ROOT    = process.env.DEV_WORKSPACES_ROOT || '/app/workspaces';
const COMPILER_QUEUE_DIR = process.env.COMPILER_QUEUE_DIR   || '/app/queue';
const COMPILER_OUTPUT_DIR = process.env.COMPILER_OUTPUT_DIR || '/app/output';

const MAX_FILE_BYTES     = 1024 * 1024;   // 1 MB per file
const MAX_LISTING        = 500;           // entries per directory listing
const COMPILE_TIMEOUT_MS = 3 * 60 * 1000; // give up polling after 3 min

const NAME_RE  = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;   // file/folder names
const SEG_RE   = /^[a-z0-9._-]{1,64}$/i;                  // username segments
const JOBID_RE = /^job_[0-9]+_[a-z0-9]{4,8}$/i;           // generated job ids

// ── path safety ───────────────────────────────────────────────────────────────
// Resolve a client-supplied path *relative to the user's own workspace root*.
// The old implementation joined raw absolute paths and only string-compared a
// prefix afterwards, which let `~/Jarvis/dev/workspaces/../..` escape. Here we
// normalize first, forbid traversal segments outright, resolve symlinks of the
// existing portion with realpath, and re-check containment at every step.
function resolveSafe(userRoot, relPath) {
  if (relPath === undefined || relPath === null) relPath = '';
  let p = String(relPath).trim();

  // Accept legacy tilde notation but treat it as workspace-relative, never home.
  if (p === '~' || p === '~/') p = '';
  if (p.startsWith('~/')) p = p.slice(2);
  if (p.startsWith('/')) p = p.replace(/^\/+/, '');

  // Reject traversal / control chars before touching the filesystem.
  if (p.includes('\0') || p.includes('..')) return { error: 'Invalid path' };

  const abs = path.normalize(path.join(userRoot, p));
  if (abs !== userRoot && !abs.startsWith(userRoot + path.sep)) {
    return { error: 'Access denied: outside your workspace' };
  }

  // If the target exists, verify its realpath is still inside the workspace
  // (defeats symlink escapes like workspace/link -> /etc).
  try {
    const real = fs.realpathSync(abs);
    if (real !== userRoot && !real.startsWith(userRoot + path.sep)) {
      return { error: 'Access denied: symlink outside workspace' };
    }
  } catch {
    // Not created yet (new files) — check nearest existing ancestor instead.
    let probe = abs;
    while (probe !== userRoot && probe.length > userRoot.length) {
      const parent = path.dirname(probe);
      try {
        const realParent = fs.realpathSync(parent);
        if (realParent !== userRoot && !realParent.startsWith(userRoot + path.sep)) {
          return { error: 'Access denied: symlink outside workspace' };
        }
        break;
      } catch { probe = parent; }
    }
  }
  return { abs, rel: path.relative(userRoot, abs) };
}

function userRootFor(username) {
  if (!SEG_RE.test(String(username || ''))) return null;
  return path.join(WORKSPACES_ROOT, username);
}

function ensureWorkspace(username) {
  const root = userRootFor(username);
  if (!root) throw Object.assign(new Error('Invalid username'), { status: 400 });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// ── compilation jobs ──────────────────────────────────────────────────────────
// Job files are shell-sourced by java-compiler/compiler-service.sh, so values
// must be strictly whitelisted (the old sanitizer stripped characters instead
// of rejecting them, silently altering paths).
function writeJobFile(job) {
  const lines = [
    `WORKSPACE_PATH="${job.workspacePath}"`,
    `TARGET="${job.target}"`,
    `JAVA_VERSION="${job.javaVersion}"`,
    `REQUESTED_BY="${job.requestedBy}"`,
    `JOB_ID="${job.jobId}"`,
    `TIMESTAMP="${job.timestamp}"`,
  ];
  fs.mkdirSync(COMPILER_QUEUE_DIR, { recursive: true });
  fs.writeFileSync(path.join(COMPILER_QUEUE_DIR, `${job.jobId}.job`), lines.join('\n') + '\n', 'utf8');
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function findArtifactDir(jobId) {
  try {
    const dirs = fs.readdirSync(COMPILER_OUTPUT_DIR).filter(d => d.startsWith(`${jobId}_`));
    dirs.sort();
    return dirs.length ? path.join(COMPILER_OUTPUT_DIR, dirs[dirs.length - 1]) : null;
  } catch { return null; }
}

function jobStatus(jobId, requestedBy) {
  if (!JOBID_RE.test(jobId)) return { status: 400, body: { error: 'Invalid job ID format' } };

  // Ownership check: only the requester may poll their own job.
  const meta = readIfExists(path.join(COMPILER_QUEUE_DIR, `${jobId}.meta.json`));
  if (meta) {
    try {
      const parsed = JSON.parse(meta);
      if (parsed.requestedBy && parsed.requestedBy !== requestedBy) {
        return { status: 403, body: { error: 'This job belongs to another user' } };
      }
    } catch { /* corrupt meta — fall through */ }
  }

  const queueFile    = path.join(COMPILER_QUEUE_DIR, `${jobId}.job`);
  const completedTag = path.join(COMPILER_QUEUE_DIR, `${jobId}.job.completed`);
  const failedTag    = path.join(COMPILER_QUEUE_DIR, `${jobId}.job.failed`);
  const artifactDir  = findArtifactDir(jobId);
  const log          = artifactDir ? readIfExists(path.join(artifactDir, 'compilation.log')) : null;

  if (fs.existsSync(completedTag)) {
    const artifact = artifactDir ? path.join(artifactDir, `deployment_${jobId}.tar.gz`) : null;
    return { status: 200, body: {
      success: true, jobId, status: 'completed', log,
      hasArtifact: !!(artifact && fs.existsSync(artifact)),
    } };
  }
  if (fs.existsSync(failedTag)) {
    return { status: 200, body: { success: true, jobId, status: 'failed', log,
      error: log ? 'Compilation failed — see log' : 'Compilation failed' } };
  }
  if (fs.existsSync(queueFile)) {
    const age = Date.now() - fs.statSync(queueFile).mtimeMs;
    if (age > COMPILE_TIMEOUT_MS) {
      return { status: 200, body: { success: false, jobId, status: 'timeout',
        error: 'Job was not picked up within 3 minutes — the compiler service may be offline' } };
    }
    return { status: 200, body: { success: true, jobId, status: 'queued', log } };
  }
  if (artifactDir) { // tags lost (volume hiccup) but output exists → treat as done
    return { status: 200, body: { success: true, jobId, status: 'completed', log, hasArtifact: true } };
  }
  return { status: 404, body: { success: false, jobId, status: 'not_found', error: 'Job not found' } };
}

// ── router ────────────────────────────────────────────────────────────────────
function createRemoteDevRouter({ requireAuth }) {
  const router = express.Router();

  const rootOf = (req) => {
    const root = userRootFor(req.user.username);
    if (!root) { const e = new Error('Invalid username'); e.status = 400; throw e; }
    return root;
  };

  // Initialize session + make sure the workspace exists.
  router.get('/connect', requireAuth, (req, res) => {
    try {
      ensureWorkspace(req.user.username);
      res.json({
        success: true,
        workspacePath: '~',
        message: 'Connected to remote development workspace',
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // List a directory (single level; the UI lazy-loads subfolders).
  router.get('/files', requireAuth, (req, res) => {
    try {
      const root = rootOf(req);
      const r = resolveSafe(root, req.query.path ?? '');
      if (r.error) return res.status(403).json({ error: r.error });

      let stat;
      try { stat = fs.statSync(r.abs); } catch { return res.status(404).json({ error: 'Path not found' }); }
      if (!stat.isDirectory()) return res.status(400).json({ error: 'Path must be a directory' });

      const names = fs.readdirSync(r.abs).slice(0, MAX_LISTING);
      const files = [];
      for (const name of names) {
        let st = null;
        try { st = fs.lstatSync(path.join(r.abs, name)); } catch { continue; }
        if (st.isSymbolicLink()) continue; // never expose symlinks in the tree
        files.push({
          name,
          path: r.rel ? `${r.rel}/${name}` : name, // workspace-relative everywhere
          type: st.isDirectory() ? 'folder' : 'file',
          size: st.size,
          modified: st.mtime.toISOString(),
        });
      }
      files.sort((a, b) =>
        (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
      res.json({ success: true, path: r.rel, files });
    } catch (err) {
      console.error('[Remote Dev Files]', err.message);
      res.status(err.status || 500).json({ error: 'Failed to list files' });
    }
  });

  // Read one text file.
  router.get('/file', requireAuth, (req, res) => {
    try {
      const root = rootOf(req);
      if (!req.query.path) return res.status(400).json({ error: 'path parameter required' });
      const r = resolveSafe(root, req.query.path);
      if (r.error) return res.status(403).json({ error: r.error });

      let stat;
      try { stat = fs.statSync(r.abs); } catch { return res.status(404).json({ error: 'File not found' }); }
      if (!stat.isFile()) return res.status(400).json({ error: 'Path is not a file' });
      if (stat.size > MAX_FILE_BYTES) return res.status(413).json({ error: 'File too large to open (max 1MB)' });

      const content = fs.readFileSync(r.abs);
      // Binary guard: don't dump NUL-laden blobs into a textarea.
      if (content.subarray(0, 8000).includes(0)) {
        return res.status(415).json({ error: 'Binary file — cannot edit in browser', size: stat.size });
      }
      res.json({ success: true, path: r.rel, content: content.toString('utf8') });
    } catch (err) {
      console.error('[Remote Dev File]', err.message);
      res.status(err.status || 500).json({ error: 'Failed to get file' });
    }
  });

  // Save one text file (atomic via temp-file + rename).
  router.put('/file', requireAuth, (req, res) => {
    try {
      const root = rootOf(req);
      const { path: p, content } = req.body || {};
      if (!p || typeof p !== 'string') return res.status(400).json({ error: 'path required' });
      if (content === undefined || content === null || typeof content !== 'string') {
        return res.status(400).json({ error: 'content must be a string' });
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
        return res.status(413).json({ error: 'File content too large (max 1MB)' });
      }
      const r = resolveSafe(root, p);
      if (r.error) return res.status(403).json({ error: r.error });

      fs.mkdirSync(path.dirname(r.abs), { recursive: true });
      const tmp = `${r.abs}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, r.abs);
      res.json({ success: true, message: 'File saved', path: r.rel });
    } catch (err) {
      console.error('[Remote Dev Save]', err.message);
      res.status(err.status || 500).json({ error: 'Failed to save file' });
    }
  });

  // Create a new empty file or a folder.
  router.post('/entry', requireAuth, (req, res) => {
    try {
      const root = rootOf(req);
      const { dir = '', name, type } = req.body || {};
      if (!NAME_RE.test(String(name || ''))) {
        return res.status(400).json({ error: 'Invalid name (letters, numbers, spaces, dots, dashes, underscores)' });
      }
      if (type !== 'file' && type !== 'folder') return res.status(400).json({ error: "type must be 'file' or 'folder'" });
      const r = resolveSafe(root, dir ? `${dir}/${name}` : name);
      if (r.error) return res.status(403).json({ error: r.error });
      if (fs.existsSync(r.abs)) return res.status(409).json({ error: 'Already exists' });

      if (type === 'folder') fs.mkdirSync(r.abs, { recursive: true });
      else { fs.mkdirSync(path.dirname(r.abs), { recursive: true }); fs.writeFileSync(r.abs, '', 'utf8'); }
      res.json({ success: true, path: r.rel, type });
    } catch (err) {
      res.status(err.status || 500).json({ error: 'Failed to create entry' });
    }
  });

  // Delete a file, or a folder recursively (only inside the user's workspace).
  router.delete('/entry', requireAuth, (req, res) => {
    try {
      const root = rootOf(req);
      const { path: p } = req.body || {};
      const r = resolveSafe(root, p);
      if (r.error) return res.status(403).json({ error: r.error });
      if (r.abs === root) return res.status(400).json({ error: 'Cannot delete the workspace root' });

      const stat = fs.lstatSync(r.abs);
      if (stat.isDirectory()) fs.rmSync(r.abs, { recursive: true, force: true });
      else fs.unlinkSync(r.abs);
      res.json({ success: true, deleted: r.rel });
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
      res.status(err.status || 500).json({ error: 'Failed to delete' });
    }
  });

  // Queue a compilation job for the caller's workspace.
  router.post('/compile', requireAuth, (req, res) => {
    try {
      const root = rootOf(req);
      const target = String(req.body?.target || 'simulation');
      if (!['simulation', 'robot'].includes(target)) {
        return res.status(400).json({ error: "target must be 'simulation' or 'robot'" });
      }
      const javaVersion = ['17', '21'].includes(String(req.body?.javaVersion))
        ? String(req.body.javaVersion) : '17';

      const jobId = `job_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      writeJobFile({
        jobId,
        workspacePath: root,            // absolute path inside the shared volume
        target,
        javaVersion,
        requestedBy: req.user.username, // already validated by rootOf()
        timestamp: new Date().toISOString(),
      });
      fs.writeFileSync(
        path.join(COMPILER_QUEUE_DIR, `${jobId}.meta.json`),
        JSON.stringify({ requestedBy: req.user.username, target }),
        'utf8',
      );
      res.json({ success: true, jobId, status: 'queued', message: 'Compilation job queued' });
    } catch (err) {
      console.error('[Compile Job]', err.message);
      res.status(err.status || 500).json({ error: 'Failed to queue compilation job' });
    }
  });

  // Poll a job's status (owner-only).
  router.get('/compile/:jobId/status', requireAuth, (req, res) => {
    const { status, body } = jobStatus(req.params.jobId, req.user.username);
    res.status(status).json(body);
  });

  // Download the compiled artifact (owner-only). Robot flashing stays behind
  // POST /api/robot/deploy (admin-gated) — students deploy via Drive/shuffle.
  router.get('/compile/:jobId/artifact', requireAuth, (req, res) => {
    const jobId = req.params.jobId;
    if (!JOBID_RE.test(jobId)) return res.status(400).json({ error: 'Invalid job ID format' });
    const check = jobStatus(jobId, req.user.username);
    if (check.status !== 200 || check.body.status !== 'completed') {
      return res.status(409).json({ error: 'Artifact not ready' });
    }
    const dir = findArtifactDir(jobId);
    const file = dir ? path.join(dir, `deployment_${jobId}.tar.gz`) : null;
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'No artifact produced' });
    res.download(file, `deployment-${req.user.username}-${jobId}.tar.gz`);
  });

  return router;
}

module.exports = { createRemoteDevRouter, resolveSafe, jobStatus, WORKSPACES_ROOT };
