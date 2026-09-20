// Robot Communication Service
// Handles telemetry retrieval and code deployment to robot (10.57.28.2)
// Acts as secure middleman between SSH server and robot

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROBOT_IP = process.env.ROBOT_IP || '10.57.28.2';
const ROBOT_API_PORT = process.env.ROBOT_API_PORT || 8080;
const ROBOT_TIMEOUT = parseInt(process.env.ROBOT_TIMEOUT || '30000', 10);

/**
 * Make HTTP request with validation of response headers
 * @param {object} options - Request options
 * @returns {Promise<object>} Response data
 */
function makeRequest(options) {
  return new Promise((resolve, reject) => {
    // Validate hostname to prevent SSRF attacks
    const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
    if (!ipRegex.test(options.hostname)) {
      // Allow localhost for development
      if (options.hostname !== 'localhost' && options.hostname !== '127.0.0.1') {
        return reject(new Error('Invalid robot IP address'));
      }
    }
    
    const req = http.request(options, (res) => {
      let data = '';
      
      // Validate content type to prevent injection attacks
      const contentType = res.headers['content-type'];
      if (contentType && !contentType.includes('application/json') && !contentType.includes('text/')) {
        req.destroy();
        return reject(new Error('Invalid content type from robot'));
      }
      
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            success: res.statusCode === 200,
            statusCode: res.statusCode,
            data: JSON.parse(data)
          });
        } catch (e) {
          resolve({
            success: res.statusCode === 200,
            statusCode: res.statusCode,
            data: data
          });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Robot request timed out after ${options.timeout || ROBOT_TIMEOUT}ms`));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Fetch telemetry from robot
 * @param {string} authToken - Bearer token for authentication
 * @returns {Promise<object>} Telemetry data
 */
async function getTelemetry(authToken = null) {
  const options = {
    hostname: ROBOT_IP,
    port: ROBOT_API_PORT,
    path: '/telemetry',
    method: 'GET',
    timeout: ROBOT_TIMEOUT,
    headers: {
      'Accept': 'application/json',
    }
  };

  if (authToken) {
    options.headers['Authorization'] = `Bearer ${authToken}`;
  }

  return makeRequest(options);
}

/**
 * Deploy compiled code to robot
 * @param {Buffer} codeArchive - Tar.gz archive of compiled code
 * @param {string} authToken - Bearer token for authentication
 * @returns {Promise<object>} Deployment result
 */
async function deployCode(codeArchive, authToken = null) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  
  const bodyParts = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="code"; filename="deployment.tar.gz"',
    'Content-Type: application/gzip',
    '',
    codeArchive.toString('base64'),
    `--${boundary}--`
  ];

  const body = Buffer.from(bodyParts.join('\r\n'));

  const options = {
    hostname: ROBOT_IP,
    port: ROBOT_API_PORT,
    path: '/deploy',
    method: 'POST',
    timeout: ROBOT_TIMEOUT * 2, // Longer timeout for deployment
    headers: {
      'Accept': 'application/json',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    }
  };

  if (authToken) {
    options.headers['Authorization'] = `Bearer ${authToken}`;
  }

  options.body = body;
  return makeRequest(options);
}

/**
 * Check robot connectivity
 * @returns {Promise<boolean>} Whether robot is reachable
 */
async function checkRobotConnection() {
  const options = {
    hostname: ROBOT_IP,
    port: ROBOT_API_PORT,
    path: '/health',
    method: 'GET',
    timeout: 5000,
    headers: {
      'Accept': 'application/json'
    }
  };

  try {
    const result = await makeRequest(options);
    return result.success;
  } catch {
    return false;
  }
}

/**
 * Submit compilation job to queue
 * @param {object} jobDetails - Job parameters
 * @returns {Promise<object>} Job submission result
 */
async function submitCompilationJob(jobDetails) {
  const queueDir = process.env.COMPILER_QUEUE_DIR || '/app/queue';
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const jobFile = path.join(queueDir, `${jobId}.job`);

  // Sanitize inputs to prevent command injection
  const sanitizePath = (p) => String(p || '').replace(/[^a-zA-Z0-9_\-./]/g, '');
  const sanitizeTarget = (t) => String(t || 'simulation').replace(/[^a-zA-Z0-9_\-]/g, '');
  const sanitizeVersion = (v) => String(v || '17').replace(/[^0-9.]/g, '');

  const jobContent = `
WORKSPACE_PATH="${sanitizePath(jobDetails.workspacePath)}"
TARGET="${sanitizeTarget(jobDetails.target)}"
JAVA_VERSION="${sanitizeVersion(jobDetails.javaVersion)}"
DEPLOY_AFTER_COMPILE="${jobDetails.deployAfterCompile ? 'true' : 'false'}"
REQUESTED_BY="${sanitizePath(jobDetails.requestedBy)}"
TIMESTAMP="${new Date().toISOString()}"
`.trim();

  try {
    await fs.promises.writeFile(jobFile, jobContent, 'utf8');
    return {
      success: true,
      jobId,
      status: 'queued',
      message: 'Compilation job queued successfully'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: 'Failed to queue compilation job'
    };
  }
}

/**
 * Get compilation job status
 * @param {string} jobId - Job ID to check
 * @returns {Promise<object>} Job status
 */
async function getJobStatus(jobId) {
  const outputDir = process.env.COMPILER_OUTPUT_DIR || '/app/output';
  const queueDir = process.env.COMPILER_QUEUE_DIR || '/app/queue';
  
  // Validate jobId format to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    return {
      success: false,
      error: 'Invalid job ID format'
    };
  }
  
  const statuses = {
    pending: path.join(queueDir, `${jobId}.job`),
    completed: path.join(queueDir, `${jobId}.job.completed`),
    failed: path.join(queueDir, `${jobId}.job.failed`)
  };

  for (const [status, filePath] of Object.entries(statuses)) {
    try {
      await fs.promises.access(filePath);
      
      // If completed or failed, try to read log
      let logContent = null;
      if (status !== 'pending') {
        const logPattern = path.join(outputDir, `${jobId}_*`, 'compilation.log');
        const dirFiles = await fs.promises.readdir(outputDir).catch(() => []);
        const jobDir = dirFiles.find(f => f.startsWith(`${jobId}_`));
        
        if (jobDir) {
          logContent = await fs.promises.readFile(
            path.join(outputDir, jobDir, 'compilation.log'),
            'utf8'
          ).catch(() => null);
        }
      }
      
      return {
        success: true,
        jobId,
        status,
        log: logContent
      };
    } catch (e) {
      // File doesn't exist, continue checking
    }
  }

  return {
    success: true,
    jobId,
    status: 'not_found',
    message: 'Job not found'
  };
}

module.exports = {
  getTelemetry,
  deployCode,
  checkRobotConnection,
  submitCompilationJob,
  getJobStatus,
  ROBOT_IP
};
