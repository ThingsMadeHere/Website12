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
 * Fetch telemetry from robot
 * @param {string} authToken - Bearer token for authentication
 * @returns {Promise<object>} Telemetry data
 */
async function getTelemetry(authToken = null) {
  return new Promise((resolve, reject) => {
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

    const req = http.request(options, (res) => {
      let data = '';
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
      reject(new Error(`Robot telemetry request timed out after ${ROBOT_TIMEOUT}ms`));
    });

    req.end();
  });
}

/**
 * Deploy compiled code to robot
 * @param {Buffer} codeArchive - Tar.gz archive of compiled code
 * @param {string} authToken - Bearer token for authentication
 * @returns {Promise<object>} Deployment result
 */
async function deployCode(codeArchive, authToken = null) {
  return new Promise((resolve, reject) => {
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

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            success: res.statusCode === 200 || res.statusCode === 201,
            statusCode: res.statusCode,
            data: JSON.parse(data)
          });
        } catch (e) {
          resolve({
            success: res.statusCode === 200 || res.statusCode === 201,
            statusCode: res.statusCode,
            data: data
          });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Robot deployment request timed out after ${ROBOT_TIMEOUT * 2}ms`));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Check robot connectivity
 * @returns {Promise<boolean>} Whether robot is reachable
 */
async function checkRobotConnection() {
  return new Promise((resolve) => {
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

    const req = http.request(options, (res) => {
      resolve(res.statusCode === 200);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.end();
  });
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

  const jobContent = `
WORKSPACE_PATH="${jobDetails.workspacePath || ''}"
TARGET="${jobDetails.target || 'simulation'}"
JAVA_VERSION="${jobDetails.javaVersion || '17'}"
DEPLOY_AFTER_COMPILE="${jobDetails.deployAfterCompile ? 'true' : 'false'}"
REQUESTED_BY="${jobDetails.requestedBy || 'unknown'}"
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
