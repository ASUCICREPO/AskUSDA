"""
Configuration constants, dataclasses, and environment variable loading.

==============================================================================
HOW TO CONFIGURE THE CRAWLER
==============================================================================

There are TWO ways to configure crawl settings:

1. ENVIRONMENT VARIABLES (for ECS/Docker deployment):
   Set these when running the container or in the ECS task definition.
   
   Required:
     SEED_URL      - URL to start crawling (e.g., "https://www.usda.gov/snap")
     S3_BUCKET     - S3 bucket for output (MUST match Bedrock KB data source)
   
   Optional:
     JOB_ID        - Custom job ID (auto-generated if not set)
     MAX_PAGES     - Max pages to scrape (default: 500)
     MAX_DEPTH     - Max link-hop depth (default: 2)
     SCOPE_TYPE    - URL filter: path|host|subdomains|all|none (default: all)
     PDF_SCOPE     - PDF download scope (default: same as SCOPE_TYPE)
     DOC_SCOPE     - Doc download scope (default: same as SCOPE_TYPE)
     USE_BROWSER   - Browser mode: auto|on|off (default: auto)
     MAX_CONCURRENT - Concurrent requests (default: 20)

2. YAML CONFIG FILE (for batch crawling multiple sites):
   Edit urls.yaml to define multiple crawl jobs.
   Run with: python -m worker --config urls.yaml
   
   See urls.yaml for format and examples.

==============================================================================
"""

import os
import uuid
from dataclasses import dataclass, field
from typing import Any, List, Optional

from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Environment-driven configuration
# ---------------------------------------------------------------------------

# S3 Storage - MUST match the Bedrock Knowledge Base data source bucket
USE_S3: bool = os.getenv("USE_S3", "false").lower() == "true"
S3_BUCKET: str = os.getenv("S3_BUCKET", "")  # REQUIRED for ECS deployment

AWS_REGION: str = os.getenv("AWS_DEFAULT_REGION", "us-east-1")

# ---------------------------------------------------------------------------
# Job identity (ECS run_task passes these as env overrides)
# ---------------------------------------------------------------------------
JOB_ID: str = os.getenv("JOB_ID", "")
SEED_URL: str = os.getenv("SEED_URL", "")

# ---------------------------------------------------------------------------
# CRAWL SCOPE SETTINGS
# ---------------------------------------------------------------------------
# SCOPE_TYPE controls which URLs are followed during crawling:
#   path       - Only URLs under same path prefix (e.g., /snap/*)
#   host       - All URLs on same domain
#   subdomains - Domain + all subdomains
#   all        - No URL filtering (follow all links)
#   none       - Skip markdown, only download PDFs/docs
SCOPE_TYPE: str = os.getenv("SCOPE_TYPE", "all")

# PDF_SCOPE and DOC_SCOPE control document download filtering
# Empty string = same as SCOPE_TYPE
PDF_SCOPE: str = os.getenv("PDF_SCOPE", "")
DOC_SCOPE: str = os.getenv("DOC_SCOPE", "")

# ---------------------------------------------------------------------------
# CRAWL DEPTH AND PAGE LIMITS
# ---------------------------------------------------------------------------
# MAX_DEPTH: How many link-hops from the seed URL
#   1 = Only pages directly linked from seed
#   2 = Pages linked from those pages (default)
#   3 = One more level deep
#   Higher values = more comprehensive but slower
MAX_DEPTH: int = int(os.getenv("MAX_DEPTH", "2"))

# MAX_PAGES: Maximum number of pages to scrape
#   500 = Default, good for testing
#   99999 = Effectively unlimited (use for production)
MAX_PAGES: int = int(os.getenv("MAX_PAGES", "500"))

# ---------------------------------------------------------------------------
# Image handling
# ---------------------------------------------------------------------------
INCLUDE_IMAGES: bool = os.getenv("INCLUDE_IMAGES", "true").lower() == "true"
DOWNLOAD_IMAGES: bool = os.getenv("DOWNLOAD_IMAGES", "false").lower() == "true"
MATERIAL_TYPES: str = os.getenv("MATERIAL_TYPES", "pdf,markdown")

# ---------------------------------------------------------------------------
# Concurrency settings
# ---------------------------------------------------------------------------
MAX_CONCURRENT: int = int(os.getenv("MAX_CONCURRENT", "20"))
PDF_DISCOVERY_CONCURRENCY: int = int(os.getenv("PDF_DISCOVERY_CONCURRENCY", "20"))
REQUEST_DELAY: float = float(os.getenv("REQUEST_DELAY", "0.3"))

# ---------------------------------------------------------------------------
# Browser-based rendering (for JS-heavy sites)
# ---------------------------------------------------------------------------
# USE_BROWSER controls JavaScript rendering:
#   auto - Try HTTP first, switch to browser if JS detected (default)
#   on   - Always use browser (for known JS-heavy sites)
#   off  - Never use browser (fastest, but fails on JS sites)
USE_BROWSER: str = os.getenv("USE_BROWSER", "auto")
BROWSER_CONCURRENCY: int = int(os.getenv("BROWSER_CONCURRENCY", "15"))
JS_DETECTION_THRESHOLD: int = 5    # ≤ this many BFS links = suspect JS site

# ---------------------------------------------------------------------------
# Limits for --no-limit mode (generous but always finite)
# ---------------------------------------------------------------------------
NO_LIMIT_MAX_PAGES: int = int(os.getenv("NO_LIMIT_MAX_PAGES", "99999"))
NO_LIMIT_MAX_DEPTH: int = int(os.getenv("NO_LIMIT_MAX_DEPTH", "10"))

# Sitemap caps
MAX_SITEMAP_ENTRIES: int = int(os.getenv("MAX_SITEMAP_ENTRIES", "5000"))
MAX_SITEMAP_SUB_FILES: int = int(os.getenv("MAX_SITEMAP_SUB_FILES", "50"))

# Rate-limiter
BACKOFF_BASE: float = 2.0
BACKOFF_MAX: float = 60.0
MAX_RETRIES: int = 3

# JS to scroll the page so lazy-loaded content appears
SCROLL_JS = """
(async () => {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 8; i++) {
        window.scrollBy(0, window.innerHeight);
        await delay(400);
    }
    window.scrollTo(0, 0);
})();
"""

# Phase names for status.json
PHASE_DISCOVERING = "DISCOVERING"
PHASE_PDF_DISCOVERY = "PDF_DISCOVERY"
PHASE_SCRAPING = "SCRAPING"
PHASE_UPLOADING = "UPLOADING"
STATUS_RUNNING = "RUNNING"
STATUS_COMPLETED = "COMPLETED"
STATUS_FAILED = "FAILED"


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class SitemapEntry:
    url: str
    lastmod: Optional[str] = None
    priority: Optional[float] = None


@dataclass
class ScopeConfig:
    name: str
    url_filter: Any           # compiled regex
    max_pages: int = 500
    max_depth: int = 3


@dataclass
class ArtifactEntry:
    type: str                 # "markdown" | "pdf" | "doc" | "image"
    source_url: str
    s3_key: str               # S3 key or local path
    size_bytes: int


@dataclass
class CrawlResult:
    url: str
    scope: str
    title: str
    word_count: int
    char_count: int
    content_type: str         # "markdown" | "pdf" | "doc" | "image"
    file_path: str
    crawled_at: str = ""
    domain: str = ""
    summary: str = ""
    price: Optional[str] = None


# Skip extensions and URL patterns
SKIP_EXT = {
    ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
    ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mp3", ".zip", ".gz",
    ".tar", ".rar", ".7z", ".exe", ".dmg", ".webp", ".bmp", ".tiff",
}

SKIP_URL_PATTERNS = [
    r"[?&](replytocom|action)=",       # Comment/action query parameters
    r"/feed/?$",                         # RSS/Atom feeds
    r"/trackback/?$",                    # Trackback endpoints
    r"/comment-page-",                   # Paginated comments
]

# Office document extensions (for --doc-scope discovery)
DOC_EXTENSIONS = (
    ".doc", ".docx", ".pptx", ".ppt", ".xlsx", ".xls", ".odt", ".ods", ".odp",
)

# Content-Type based detection — the general-purpose way to identify PDFs/docs
# regardless of URL patterns. Works for ANY CMS or file server.
PDF_CONTENT_TYPES = {
    "application/pdf",
}

DOC_CONTENT_TYPES = {
    "application/msword",                                                          # .doc
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",      # .docx
    "application/vnd.ms-excel",                                                    # .xls
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",            # .xlsx
    "application/vnd.ms-powerpoint",                                               # .ppt
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",   # .pptx
    "application/vnd.oasis.opendocument.text",                                     # .odt
    "application/vnd.oasis.opendocument.spreadsheet",                              # .ods
    "application/vnd.oasis.opendocument.presentation",                             # .odp
}

