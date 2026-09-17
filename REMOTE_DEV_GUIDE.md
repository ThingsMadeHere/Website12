# Remote Development Setup Guide

## Overview

The MCHS Robotics team now has a secure remote development environment integrated directly into the team website. Signed-in members can access a web-based IDE to edit robot code, compile it, and deploy to either simulation or the actual robot.

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   React Site    │────▶│  API Server  │────▶│  SSH Server     │
│  (Remote Dev UI)│     │  (Auth/API)  │     │  (File Access)  │
└─────────────────┘     └──────────────┘     └─────────────────┘
                               │                      │
                               ▼                      ▼
                        ┌──────────────┐     ┌─────────────────┐
                        │   Compiler   │     │    Robot        │
                        │   Queue      │     │  (10.57.28.2)   │
                        └──────────────┘     └─────────────────┘
```

## Security Features

### Authentication & Authorization
- **Sign-in Required**: Only authenticated team members can access Remote Dev
- **Workspace Isolation**: Each user is restricted to their own `~/Jarvis/dev/workspaces/{username}` directory
- **Path Validation**: All file operations validate that users cannot escape their workspace

### SSH Server Hardening
- **Key-only Authentication**: No password authentication allowed
- **Modern Cryptography**: Only ed25519 keys, AES-GCM encryption, SHA2 hashing
- **Connection Limits**: Max 2 auth attempts, 30s login grace time
- **No Forwarding**: X11, TCP, and agent forwarding all disabled
- **Chroot-like Restriction**: ForceCommand limits operations to file editing

### Network Security
- **Robot Firewall**: Only accepts connections from 10.57.28.2
- **API Middleware**: All robot communication goes through authenticated API endpoints
- **Rate Limiting**: Compilation queue prevents resource exhaustion

## Features

### Web IDE
- **File Browser**: Navigate your workspace folder structure
- **Code Editor**: Syntax-highlighted Java editor with auto-save
- **Real-time Status**: See compilation and deployment progress
- **One-click Deploy**: Compile and deploy to simulation or robot

### Compilation Queue
- **Java 17/25 Support**: Current WPLib uses Java 17, ready for 2027 (Java 25)
- **Sequential Processing**: Jobs processed one at a time to prevent conflicts
- **Build Tools**: Supports Maven, Gradle, and direct javac compilation
- **Artifact Management**: Compiled JARs stored for deployment

### Robot Integration
- **Telemetry Fetching**: Get real-time robot status
- **Code Deployment**: Push compiled code to robot
- **Health Monitoring**: Check robot connectivity

## Usage

### Accessing Remote Dev
1. Sign in to the MCHS Robotics website
2. Click "Remote Dev" in the navigation bar
3. Your workspace loads automatically

### Editing Files
1. Browse files in the left sidebar
2. Click any file to open it in the editor
3. Make changes and click "Save"
4. Changes are saved to your workspace

### Compiling & Deploying
1. Click "Compile (Sim)" to build and test in simulation
2. Click "Deploy to Robot" to build and deploy to the physical robot
3. Watch the status bar for progress and results

## File Structure

```
~/Jarvis/dev/workspaces/
├── {username}/          # Your personal workspace
│   ├── src/             # Robot code source
│   ├── vendordeps/      # WPILib dependencies
│   ├── build.gradle     # Gradle build config
│   └── settings.gradle  # Gradle settings
```

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/remote-dev/connect` | GET | ✓ | Initialize session |
| `/api/remote-dev/files` | GET | ✓ | List workspace files |
| `/api/remote-dev/file` | GET | ✓ | Get file content |
| `/api/remote-dev/file` | PUT | ✓ | Save file content |
| `/api/robot/compile` | POST | ✓ | Queue compilation job |
| `/api/robot/deploy` | POST | Admin | Deploy to robot |
| `/api/robot/telemetry` | GET | ✓ | Fetch robot telemetry |

## Troubleshooting

### "Access denied" errors
- Ensure you're signed in
- Verify you're only accessing files in your own workspace

### Compilation fails
- Check that your code compiles locally first
- Ensure all dependencies are in vendordeps/
- Review compilation error messages in status bar

### Cannot connect to robot
- Verify robot is powered on and networked
- Check that robot IP (10.57.28.2) is reachable
- Contact an admin if deployment requires admin privileges

## Future Enhancements

- Real-time collaboration (multi-user editing)
- Integrated terminal access
- Git integration for version control
- Automated testing on compilation
- Java 25 support for WPLib 2027
