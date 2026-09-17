# Java Compilation Queue Service for WPlib
# Handles Java 17/25 compilation for robot code deployment
# Queue-based architecture for safe concurrent deployments

FROM eclipse-temurin:17-jdk-alpine

# Install build tools and queue dependencies
RUN apk add --no-cache \
    bash \
    git \
    maven \
    gradle \
    && rm -rf /var/cache/apk/*

# Create non-root user for compilation
RUN addgroup -g 1001 java-compiler && \
    adduser -u 1001 -G java-compiler -h /home/java-compiler -D java-compiler

# Create directories
RUN mkdir -p /app/queue /app/workspaces /app/output && \
    chown -R java-compiler:java-compiler /app

WORKDIR /app

# Copy compiler service
COPY compiler-service.sh /app/compiler-service.sh
COPY process-compilation.sh /app/process-compilation.sh
RUN chmod +x /app/*.sh && \
    chown java-compiler:java-compiler /app/*.sh

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD pgrep -f compiler-service.sh > /dev/null || exit 1

USER java-compiler
ENTRYPOINT ["/app/compiler-service.sh"]
