# WPlib Remote Development - SSH & Compilation Setup

## Overview

This setup provides ultra-secure remote development capabilities for WPlib with:
- **SSH Server**: Restricted SFTP access to `~/Jarvis/dev/workspaces`
- **Java Compiler Queue**: Sequential compilation jobs for robot code deployment
- **Robot API Integration**: Telemetry retrieval and code deployment via the API

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Robot     │────▶│  API (Port   │────▶│   SSH       │
│ 10.57.28.2  │     │    3001)     │     │   Server    │
│             │     │              │     │ (Port 2222) │
└─────────────┘     └──────────────┘     └─────────────┘
                           │                    │
                           ▼                    ▼
                  ┌──────────────┐     ┌─────────────┐
                  │   Java       │     │  Workspaces │
                  │  Compiler    │     │  Volume     │
                  │   Queue      │     │             │
                  └──────────────┘     └─────────────┘
```

## Security Features

### SSH Server Hardening
- **Key-only authentication** (no passwords allowed)
- **Restricted algorithms**: ed25519, AES-GCM, SHA2 only
- **Single user**: `wplib-dev`
- **Chroot-style restriction**: Only `~/Jarvis/dev/workspaces` accessible
- **No forwarding**: X11, TCP, agent, and tunnel forwarding disabled
- **Strict limits**: Max 2 auth attempts, 30s login grace time
- **Verbose logging**: All connections logged for audit

### Network Security
- Only accepts connections from robot IP (10.57.28.2)
- Non-standard port (2222) for obscurity
- Isolated Docker network

## Setup Instructions

### 1. Generate SSH Key Pair (if you don't have one)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/wplib-dev -C "wplib-dev"
```

### 2. Copy Public Key to authorized_keys

```bash
cat ~/.ssh/wplib-dev.pub > ./ssh-keys/authorized_keys
```

Or append if file exists:
```bash
cat ~/.ssh/wplib-dev.pub >> ./ssh-keys/authorized_keys
```

### 3. Start Services

```bash
docker compose up -d ssh-server java-compiler api
```

### 4. Verify Services

```bash
# Check SSH server
docker logs wplib-ssh

# Check compiler queue
docker logs wplib-compiler

# Check API robot connectivity
docker logs mchs-api | grep Robot
```

## API Endpoints

All endpoints require authentication (admin required for deployment).

### Get Robot Telemetry
```bash
GET /api/robot/telemetry
```

### Check Robot Connectivity
```bash
GET /api/robot/health
```

### Submit Compilation Job
```bash
POST /api/robot/compile
Content-Type: application/json

{
  "workspacePath": "/app/workspaces/my-robot-code",
  "target": "simulation",  // or "robot"
  "javaVersion": "17"      // will support "25" for WPLIB 2027
}
```

Response:
```json
{
  "success": true,
  "jobId": "job_1694523847_abc123",
  "status": "queued",
  "message": "Compilation job queued successfully"
}
```

### Check Compilation Status
```bash
GET /api/robot/compile/:jobId/status
```

### Deploy Code to Robot
```bash
POST /api/robot/deploy
Content-Type: application/json

{
  "codeArchive": "<base64-encoded-tar-gz>"
}
```

## Compilation Queue

The Java compiler service processes jobs sequentially:

1. Jobs are submitted via API to `/app/queue`
2. Compiler monitors queue directory
3. Each job is processed one at a time (FIFO order)
4. Results stored in `/app/output` with logs

### Supported Build Systems
- Maven (pom.xml)
- Gradle (build.gradle, build.gradle.kts)
- Basic javac (for simple projects)

### Java Version Support
- **Current**: Java 17
- **Future**: Java 25 (for WPLIB 2027)

Specify version in compilation job:
```json
{
  "javaVersion": "25"
}
```

## Directory Structure

```
/workspace/
├── ssh-server/           # SSH server Dockerfiles and config
│   ├── Dockerfile
│   ├── sshd_config       # Hardened SSH configuration
│   └── entrypoint.sh
├── java-compiler/        # Compilation queue service
│   ├── Dockerfile
│   ├── compiler-service.sh
│   └── process-compilation.sh
├── ssh-keys/             # SSH public keys (gitignored)
│   └── authorized_keys
├── api/
│   └── robot.js          # Robot communication module
└── docker-compose.yml    # Updated with new services
```

## Volumes

- `wplib_workspaces`: Shared workspace directory (`~/Jarvis/dev/workspaces`)
- `ssh_host_keys`: SSH host key persistence
- `compiler_queue`: Job queue directory
- `compiler_output`: Compilation results and logs

## Troubleshooting

### SSH Connection Fails
1. Verify public key is in `./ssh-keys/authorized_keys`
2. Check SSH server logs: `docker logs wplib-ssh`
3. Ensure correct permissions: `chmod 600 ./ssh-keys/authorized_keys`

### Compilation Job Stuck
1. Check queue directory: `docker exec wplib-compiler ls /app/queue`
2. View compiler logs: `docker logs wplib-compiler`
3. Check for lock file: `docker exec wplib-compiler ls /tmp/compiler.lock`

### Robot Connection Issues
1. Verify robot is reachable from API container
2. Check robot API endpoint configuration
3. Review API logs: `docker logs mchs-api | grep Robot`

## Future Enhancements

- [ ] Add reverse SSH tunnel from container to robot
- [ ] Support for Java 25 when WPLIB 2027 releases
- [ ] WebSocket-based real-time compilation progress
- [ ] Multi-user support with isolated workspaces
- [ ] Automated testing before deployment
