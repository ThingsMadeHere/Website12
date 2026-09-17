#!/bin/bash
# Java Compilation Queue Service
# Monitors queue directory and processes compilation jobs sequentially

set -e

QUEUE_DIR="/app/queue"
WORKSPACE_DIR="/app/workspaces"
OUTPUT_DIR="/app/output"
LOCK_FILE="/tmp/compiler.lock"

echo "[Compiler Service] Starting Java compilation queue service..."
echo "[Compiler Service] Queue directory: $QUEUE_DIR"
echo "[Compiler Service] Java version: $(java -version 2>&1 | head -1)"

# Ensure directories exist
mkdir -p "$QUEUE_DIR" "$WORKSPACE_DIR" "$OUTPUT_DIR"

# Function to acquire lock (ensures single-threaded compilation)
acquire_lock() {
    while ! mkdir "$LOCK_FILE" 2>/dev/null; do
        echo "[Compiler] Waiting for lock (another compilation in progress)..."
        sleep 2
    done
    trap 'rm -rf "$LOCK_FILE"' EXIT
}

# Function to process a single compilation job
process_job() {
    local job_file="$1"
    local job_id=$(basename "$job_file" .job)
    
    echo "[Compiler] Processing job $job_id..."
    
    # Read job parameters
    source "$job_file"
    
    # Validate job
    if [ -z "$WORKSPACE_PATH" ] || [ -z "$TARGET" ]; then
        echo "[Compiler] Job $job_id: Invalid job file (missing WORKSPACE_PATH or TARGET)"
        mv "$job_file" "${job_file}.failed"
        return 1
    fi
    
    # Determine Java version (default to 17, support 25 for WPLIB 2027)
    local java_version="${JAVA_VERSION:-17}"
    echo "[Compiler] Job $job_id: Using Java $java_version for target: $TARGET"
    
    # Execute compilation script
    /app/process-compilation.sh "$job_id" "$WORKSPACE_PATH" "$TARGET" "$java_version"
    local result=$?
    
    if [ $result -eq 0 ]; then
        echo "[Compiler] Job $job_id: Completed successfully"
        mv "$job_file" "${job_file}.completed"
    else
        echo "[Compiler] Job $job_id: Failed with exit code $result"
        mv "$job_file" "${job_file}.failed"
    fi
    
    return $result
}

# Main loop - process jobs from queue
echo "[Compiler] Monitoring queue for new jobs..."
while true; do
    # Find oldest pending job (FIFO order)
    oldest_job=$(find "$QUEUE_DIR" -name "*.job" -type f 2>/dev/null | sort | head -1)
    
    if [ -n "$oldest_job" ] && [ -f "$oldest_job" ]; then
        echo "[Compiler] Found pending job: $(basename $oldest_job)"
        
        # Acquire exclusive lock
        acquire_lock
        
        # Process the job
        process_job "$oldest_job" || true
        
        # Release lock
        rm -rf "$LOCK_FILE"
    else
        # No jobs, wait before checking again
        sleep 5
    fi
done
