#!/bin/bash
# Entrypoint wrapper: runs the Python crawler and writes FAILED status on crash/OOM.
# This catches cases where Python itself is killed (SIGKILL from OOM, segfault)
# and the signal handler / atexit can't run.

set -o pipefail

# Run the crawler
python -m worker "$@"
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
    echo ""
    echo "  [ENTRYPOINT] Crawler exited with code $EXIT_CODE — writing FAILED status to S3"

    # Determine error message based on exit code
    case $EXIT_CODE in
        137) ERROR_MSG="Process killed (SIGKILL/OOM) — exit code 137" ;;
        139) ERROR_MSG="Segmentation fault — exit code 139" ;;
        143) ERROR_MSG="Process terminated (SIGTERM) — exit code 143" ;;
        *)   ERROR_MSG="Process crashed — exit code $EXIT_CODE" ;;
    esac

    # Write FAILED status.json to S3 (best-effort)
    if [ -n "$S3_BUCKET" ] && [ -n "$JOB_ID" ] && [ "$USE_S3" = "true" ]; then
        SEED="${SEED_URL:-unknown}"
        NOW=$(date -u +"%Y-%m-%dT%H:%M:%S+00:00")
        STATUS_JSON=$(cat <<ENDJSON
{
  "jobId": "$JOB_ID",
  "status": "FAILED",
  "seedUrl": "$SEED",
  "startedAt": "$NOW",
  "updatedAt": "$NOW",
  "phase": "CRASHED",
  "artifactCount": 0,
  "artifactKeys": [],
  "error": "$ERROR_MSG"
}
ENDJSON
)
        echo "$STATUS_JSON" | aws s3 cp - "s3://$S3_BUCKET/jobs/$JOB_ID/status.json" \
            --content-type "application/json" 2>/dev/null || true
        echo "  [ENTRYPOINT] FAILED status written to s3://$S3_BUCKET/jobs/$JOB_ID/status.json"
    fi
fi

exit $EXIT_CODE
