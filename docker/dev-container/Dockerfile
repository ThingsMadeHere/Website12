FROM node:18-alpine

# Install Java for FRC compilation and development tools
RUN apk add --no-cache openjdk17 maven git python3 make g++ openssh-server bash

# Create non-root user for security
RUN addgroup -g 1001 appgroup && \
    adduser -u 1001 -G appgroup -D appuser

# Set working directory
WORKDIR /home/appuser/workspace

# Create workspace directories with proper permissions
RUN mkdir -p /home/appuser/workspace/Jarvis/dev/workspaces && \
    chown -R appuser:appgroup /home/appuser/workspace

# Configure SSH server for VS Code Remote SSH
RUN mkdir -p /run/sshd && \
    ssh-keygen -A && \
    echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config && \
    echo "PermitRootLogin no" >> /etc/ssh/sshd_config && \
    echo "AllowUsers appuser" >> /etc/ssh/sshd_config && \
    echo "Port 2222" >> /etc/ssh/sshd_config

# Expose SSH port for VS Code Remote SSH
EXPOSE 2222

# Switch to non-root user
USER appuser

# Default command keeps container running
CMD ["/bin/sh", "-c", "while true; do sleep 3600; done"]
