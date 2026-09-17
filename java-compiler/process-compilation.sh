#!/bin/bash
# Process a single Java compilation job
# Arguments: job_id workspace_path target java_version

set -e

JOB_ID="$1"
WORKSPACE_PATH="$2"
TARGET="$3"
JAVA_VERSION="${4:-17}"

OUTPUT_DIR="/app/output"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "[Compile] Job $JOB_ID: Starting compilation for $TARGET"
echo "[Compile] Workspace: $WORKSPACE_PATH"
echo "[Compile] Java version: $JAVA_VERSION"

# Create output directory for this job
JOB_OUTPUT="$OUTPUT_DIR/${JOB_ID}_${TIMESTAMP}"
mkdir -p "$JOB_OUTPUT"

LOG_FILE="$JOB_OUTPUT/compilation.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Compilation Job $JOB_ID ==="
log "Target: $TARGET"
log "Java Version: $JAVA_VERSION"

# Check if workspace exists
if [ ! -d "$WORKSPACE_PATH" ]; then
    log "ERROR: Workspace directory does not exist: $WORKSPACE_PATH"
    exit 1
fi

cd "$WORKSPACE_PATH"

# Detect build system and compile
if [ -f "pom.xml" ]; then
    log "Detected Maven project (pom.xml)"
    log "Running: mvn clean compile"
    
    if command -v mvn &> /dev/null; then
        mvn clean compile -q 2>&1 | tee -a "$LOG_FILE"
        MAVEN_RESULT=$?
        
        if [ $MAVEN_RESULT -eq 0 ]; then
            log "Maven compilation successful"
            # Copy JAR if produced
            find target -name "*.jar" -type f 2>/dev/null | head -5 | while read jar; do
                cp "$jar" "$JOB_OUTPUT/" 2>/dev/null || true
            done
        else
            log "ERROR: Maven compilation failed with exit code $MAVEN_RESULT"
            exit 1
        fi
    else
        log "WARNING: Maven not installed, attempting basic javac compilation"
        # Fallback to basic javac
        find src -name "*.java" > "$JOB_OUTPUT/sources.txt"
        if [ -s "$JOB_OUTPUT/sources.txt" ]; then
            mkdir -p "$JOB_OUTPUT/classes"
            javac -d "$JOB_OUTPUT/classes" @"$JOB_OUTPUT/sources.txt" 2>&1 | tee -a "$LOG_FILE"
        fi
    fi
    
elif [ -f "build.gradle" ] || [ -f "build.gradle.kts" ]; then
    log "Detected Gradle project"
    log "Running: gradle build"
    
    if command -v gradle &> /dev/null; then
        gradle build -x test -q 2>&1 | tee -a "$LOG_FILE"
        GRADLE_RESULT=$?
        
        if [ $GRADLE_RESULT -eq 0 ]; then
            log "Gradle compilation successful"
            # Copy JAR if produced
            find build/libs -name "*.jar" -type f 2>/dev/null | head -5 | while read jar; do
                cp "$jar" "$JOB_OUTPUT/" 2>/dev/null || true
            done
        else
            log "ERROR: Gradle compilation failed with exit code $GRADLE_RESULT"
            exit 1
        fi
    else
        log "WARNING: Gradle not installed, attempting basic javac compilation"
        # Fallback to basic javac
        find src -name "*.java" > "$JOB_OUTPUT/sources.txt"
        if [ -s "$JOB_OUTPUT/sources.txt" ]; then
            mkdir -p "$JOB_OUTPUT/classes"
            javac -d "$JOB_OUTPUT/classes" @"$JOB_OUTPUT/sources.txt" 2>&1 | tee -a "$LOG_FILE"
        fi
    fi
    
else
    log "No build system detected (no pom.xml or build.gradle)"
    log "Attempting basic javac compilation of all .java files"
    
    JAVA_FILES=$(find . -name "*.java" -type f 2>/dev/null | wc -l)
    if [ "$JAVA_FILES" -eq 0 ]; then
        log "WARNING: No Java source files found"
        exit 0
    fi
    
    find . -name "*.java" -type f > "$JOB_OUTPUT/sources.txt"
    mkdir -p "$JOB_OUTPUT/classes"
    
    if [ -s "$JOB_OUTPUT/sources.txt" ]; then
        javac -d "$JOB_OUTPUT/classes" @"$JOB_OUTPUT/sources.txt" 2>&1 | tee -a "$LOG_FILE"
        JAVAC_RESULT=$?
        
        if [ $JAVAC_RESULT -ne 0 ]; then
            log "ERROR: javac compilation failed with exit code $JAVAC_RESULT"
            exit 1
        fi
        
        log "Basic javac compilation successful ($JAVA_FILES files)"
    fi
fi

# Create deployment package
log "Creating deployment package..."
cd "$JOB_OUTPUT"
tar -czf "deployment_${JOB_ID}.tar.gz" *.jar classes/ 2>/dev/null || \
    tar -czf "deployment_${JOB_ID}.tar.gz" classes/ 2>/dev/null || true

log "Deployment package created: deployment_${JOB_ID}.tar.gz"
log "=== Compilation Complete ==="

exit 0
