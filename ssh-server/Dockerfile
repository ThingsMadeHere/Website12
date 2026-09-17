# Ultra-Secure SSH Server for WPlib Remote Development
# Connects OUTBOUND to robot (10.57.28.2) via reverse tunnel
# Only accepts connections from 10.57.28.2

FROM alpine:3.19

# Install OpenSSH server and dependencies
RUN apk add --no-cache \
    openssh-server \
    openssh-client \
    openjdk17 \
    bash \
    git \
    && rm -rf /var/cache/apk/*

# Create non-root user for development
RUN addgroup -g 1000 wplib-dev && \
    adduser -u 1000 -G wplib-dev -h /home/wplib-dev -D wplib-dev

# Set up home directory structure
RUN mkdir -p /home/wplib-dev/Jarvis/dev/workspaces && \
    chown -R wplib-dev:wplib-dev /home/wplib-dev

# Generate SSH host keys (RSA 4096-bit for maximum security)
RUN ssh-keygen -A

# Copy hardened SSH configuration
COPY sshd_config /etc/ssh/sshd_config

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose port 2222 (non-standard for obscurity)
EXPOSE 2222

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD pgrep -x sshd > /dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/etc/ssh/sshd_config"]
