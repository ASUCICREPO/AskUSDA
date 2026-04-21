"""
Storage backend: local filesystem or S3.
Handles status.json tracking, manifest.json, CSV reports.
"""

import csv
import io
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from .config import (
    USE_S3, S3_BUCKET,
    ArtifactEntry,
    PHASE_DISCOVERING, STATUS_RUNNING, STATUS_COMPLETED, STATUS_FAILED,
)

if USE_S3:
    import boto3
    _s3 = boto3.client("s3")


class StorageBackend:

    def __init__(self, output_dir: str, job_id: str):
        self.job_id = job_id
        self.output_dir = Path(output_dir)
        self._artifacts: List[ArtifactEntry] = []

    # ------------------------------------------------------------------
    # Low-level save
    # ------------------------------------------------------------------

    def _local_dir(self, *parts: str) -> Path:
        d = self.output_dir / self.job_id
        for p in parts:
            if p:
                d = d / p
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _s3_key(self, *parts: str) -> str:
        return "/".join(["jobs", self.job_id] + [p for p in parts if p])

    def save_text(self, scope: str, kind: str, filename: str, text: str,
                  content_type: str = "text/plain") -> str:
        if USE_S3:
            key = self._s3_key(scope, kind, filename)
            _s3.put_object(Bucket=S3_BUCKET, Key=key,
                           Body=text.encode("utf-8"), ContentType=content_type)
            return f"s3://{S3_BUCKET}/{key}"
        path = self._local_dir(scope, kind) / filename
        path.write_text(text, encoding="utf-8")
        return str(path)

    def save_bytes(self, scope: str, kind: str, filename: str, data: bytes,
                   content_type: str = "application/octet-stream") -> str:
        if USE_S3:
            key = self._s3_key(scope, kind, filename)
            _s3.put_object(Bucket=S3_BUCKET, Key=key,
                           Body=data, ContentType=content_type)
            return f"s3://{S3_BUCKET}/{key}"
        path = self._local_dir(scope, kind) / filename
        path.write_bytes(data)
        return str(path)

    # ------------------------------------------------------------------
    # Artifact tracking
    # ------------------------------------------------------------------

    def record_artifact(self, art: ArtifactEntry):
        self._artifacts.append(art)

    # ------------------------------------------------------------------
    # status.json — written at each phase transition
    # ------------------------------------------------------------------

    def write_status(self, seed_url: str, status: str, phase: str,
                     error: Optional[str] = None,
                     started_at: Optional[str] = None,
                     progress: Optional[Dict] = None):
        doc = {
            "jobId": self.job_id,
            "status": status,
            "seedUrl": seed_url,
            "startedAt": started_at or datetime.now(timezone.utc).isoformat(),
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "phase": phase,
            "artifactCount": len(self._artifacts),
            "artifactKeys": [a.s3_key for a in self._artifacts],
            "error": error,
        }
        if progress:
            doc["progress"] = progress
        text = json.dumps(doc, indent=2)

        if USE_S3:
            key = self._s3_key("status.json")
            _s3.put_object(Bucket=S3_BUCKET, Key=key,
                           Body=text.encode("utf-8"),
                           ContentType="application/json")
        else:
            path = self._local_dir() / "status.json"
            path.write_text(text, encoding="utf-8")

    # ------------------------------------------------------------------
    # manifest.json — final artifact index
    # ------------------------------------------------------------------

    def write_manifest(self, seed_url: str):
        doc = {
            "jobId": self.job_id,
            "seedUrl": seed_url,
            "crawledAt": datetime.now(timezone.utc).isoformat(),
            "totalArtifacts": len(self._artifacts),
            "artifacts": [
                {
                    "type": a.type,
                    "sourceUrl": a.source_url,
                    "s3Key": a.s3_key,
                    "sizeBytes": a.size_bytes,
                }
                for a in self._artifacts
            ],
        }
        text = json.dumps(doc, indent=2)

        if USE_S3:
            key = self._s3_key("manifest.json")
            _s3.put_object(Bucket=S3_BUCKET, Key=key,
                           Body=text.encode("utf-8"),
                           ContentType="application/json")
        else:
            path = self._local_dir() / "manifest.json"
            path.write_text(text, encoding="utf-8")

    # ------------------------------------------------------------------
    # CSV report
    # ------------------------------------------------------------------

    def save_csv(self, rows: List[Dict], filename: str) -> str:
        if not rows:
            return ""
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
        text = buf.getvalue()

        if USE_S3:
            key = self._s3_key(filename)
            _s3.put_object(Bucket=S3_BUCKET, Key=key,
                           Body=text.encode("utf-8"), ContentType="text/csv")
            return f"s3://{S3_BUCKET}/{key}"

        d = self._local_dir()
        p = d / filename
        p.write_text(text, encoding="utf-8")
        return str(p)
