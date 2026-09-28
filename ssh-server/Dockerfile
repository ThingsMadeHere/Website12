# Ultra-Secure SSH Server for WPlib Remote Development
# Key-only authentication, chrooted SFTP into the shared workspaces volume.

FROM alpine:3.19

# OpenSSH server/client + tools students expect inside the dev sandbox
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

# Set up home directory structure for chroot SFTP.
# ChrootDirectory must be owned by root with no write permissions for the user;
# the innermost workspaces dir is owned by wplib-dev so uploads still work.
RUN mkdir -p /home/wplib-dev/Jarvis/dev/workspaces && \
    chown root:root /home/wplib-dev && \
    chmod 755 /home/wplib-dev && \
    chown root:root /home/wplib-dev/Jarvis && \
    chmod 755 /home/wplib-dev/Jarvis && \
    chown root:root /home/wplib-dev/Jarvis/dev && \
    chmod 755 /home/wplib-dev/Jarvis/dev && \
    chown wplib-dev:wplib-dev /home/wplib-dev/Jarvis/dev/workspaces && \
    chmod 755 /home/wplib-dev/Jarvis/dev/workspaces

# Copy hardened SSH configuration (main file + drop-in hardening policy).
# A pristine copy also lives under /opt/sshd: the ssh_host_keys volume is
# mounted over /etc/ssh at runtime and would otherwise hide these files, so
# the entrypoint restores them from /opt/sshd on every boot.
COPY sshd_config /etc/ssh/sshd_config
COPY sshd_config.d /etc/ssh/sshd_config.d
RUN chmod 644 /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf && \
    mkdir -p /opt/sshd && \
    cp /etc/ssh/sshd_config /opt/sshd/sshd_config && \
    cp -r /etc/ssh/sshd_config.d /opt/sshd/sshd_config.d

# Make sure runtime dirs sshd needs exist (empty /run/sshd on some images)
RUN mkdir -p /run/sshd

# Fail the BUILD if the config is invalid — "Bad key types" / unsupported
# option mistakes can no longer ship to production unnoticed. Host keys are
# generated first so the test has something to validate against.
RUN ssh-keygen -A && /usr/sbin/sshd -t -f /etc/ssh/sshd_config

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
