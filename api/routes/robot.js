'use strict';
// ── robot telemetry & deployment routes ──────────────────────────────────────
// Thin HTTP layer over the robot service module (api/robot.js). The API server
// acts as the secure middleman between the browser and the robot / compiler
// queue — nothing here talks to another feature module directly.

const express = require('express');
const robot = require('../robot');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();

/**
 * GET /telemetry - Fetch telemetry from robot (10.57.28.2)
 * Requires authentication
 */
router.get('/telemetry', requireAuth, async (req, res) => {
  try {
    const result = await robot.getTelemetry(req.user?.token);

    if (result.success) {
      res.json({ success: true, data: result.data });
    } else {
      res.status(result.statusCode || 503).json({
        success: false,
        error: 'Failed to fetch telemetry from robot',
        details: result.data
      });
    }
  } catch (error) {
    console.error('[Robot Telemetry] Error:', error.message);
    res.status(503).json({
      success: false,
      error: 'Robot communication failed',
      details: error.message
    });
  }
});

/**
 * POST /deploy - Deploy compiled code to robot
 * Requires admin authentication
 * Accepts base64-encoded tar.gz in request body
 */
router.post('/deploy', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Expect base64-encoded tar.gz in request body
    const { codeArchive } = req.body;

    if (!codeArchive) {
      return res.status(400).json({
        success: false,
        error: 'No code archive provided'
      });
    }

    const archiveBuffer = Buffer.from(codeArchive, 'base64');
    const result = await robot.deployCode(archiveBuffer, req.user?.token);

    if (result.success) {
      res.json({
        success: true,
        message: 'Code deployed successfully to robot',
        data: result.data
      });
    } else {
      res.status(result.statusCode || 500).json({
        success: false,
        error: 'Deployment failed',
        details: result.data
      });
    }
  } catch (error) {
    console.error('[Robot Deploy] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Deployment failed',
      details: error.message
    });
  }
});

/**
 * POST /compile - Submit code compilation job to queue
 * Requires authentication
 * Body: { workspacePath, target?, javaVersion? }
 */
router.post('/compile', requireAuth, async (req, res) => {
  try {
    const { workspacePath, target = 'simulation', javaVersion = '17' } = req.body || {};

    if (!workspacePath) {
      return res.status(400).json({
        success: false,
        error: 'workspacePath is required'
      });
    }

    const result = await robot.submitCompilationJob({
      workspacePath,
      target,
      javaVersion,
      requestedBy: req.user.username
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('[Compile Job] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to queue compilation job',
      details: error.message
    });
  }
});

/**
 * GET /compile/:jobId/status - Get compilation job status
 * Requires authentication
 */
router.get('/compile/:jobId/status', requireAuth, async (req, res) => {
  try {
    const { jobId } = req.params;
    const result = await robot.getJobStatus(jobId);
    res.json(result);
  } catch (error) {
    console.error('[Job Status] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to get job status',
      details: error.message
    });
  }
});

/**
 * GET /health - Check robot connectivity
 * Requires authentication
 */
router.get('/health', requireAuth, async (req, res) => {
  try {
    const connected = await robot.checkRobotConnection();
    res.json({
      success: true,
      connected,
      robotIp: robot.ROBOT_IP
    });
  } catch (error) {
    console.error('[Robot Health] Error:', error.message);
    res.status(503).json({
      success: false,
      connected: false,
      error: error.message
    });
  }
});

module.exports = router;
