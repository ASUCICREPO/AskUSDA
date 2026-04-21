"""
Entry point for the web crawler.

Architecture:
  Phase 1:    Sitemap discovery — find all page URLs
  Phase 1b:   BFS link crawl fallback — auto when no sitemap found
  Phase 1b+:  Auto-detect JS sites — if BFS finds ≤5 links, retry with browser (crawl4ai)
  Phase 1.5:  Document discovery — HTTP scan for PDF + office doc links (browser if activated)
  Phase 2:    Parallel execution (browser if activated):
              a) Lightweight markdown scraping (aiohttp/browser + html2text) — all pages
              b) PDF downloads — all discovered PDFs
              c) Doc downloads — all discovered office documents
  Phase 2.5:  Extra PDF + doc downloads found during scraping
  Phase 2.6:  Image downloads (optional)
  Phase 3:    Reports & manifest + browser cleanup

Browser modes (--use-browser / USE_BROWSER env):
  auto:  Try aiohttp first; if BFS finds ≤2 links, auto-launch browser (default)
  on:    Always use browser for all phases (for known JS sites)
  off:   Never use browser (pure aiohttp, fastest but fails on JS sites)

Trigger methods:
  1. CLI:       python -m worker.main --url "https://example.com"
  2. Env vars:  SEED_URL="https://example.com" JOB_ID="abc-123" python -m worker.main
  3. Shell:     ./trigger_crawl.sh "https://example.com"
  4. ECS:       ecs.run_task() with env overrides
  5. Config:    python -m worker.main --config urls.yaml
"""

import argparse
import asyncio
import hashlib
import json
import os
import random
import signal
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Set
from urllib.parse import urlparse, urlunparse, urljoin

import httpx
import yaml

from .config import (
    USE_S3, S3_BUCKET, MAX_CONCURRENT,
    SEED_URL, JOB_ID, SCOPE_TYPE, PDF_SCOPE, DOC_SCOPE,
    INCLUDE_IMAGES, DOWNLOAD_IMAGES,
    MAX_DEPTH, MAX_PAGES, NO_LIMIT_MAX_PAGES, NO_LIMIT_MAX_DEPTH,
    PHASE_DISCOVERING, PHASE_PDF_DISCOVERY, PHASE_SCRAPING, PHASE_UPLOADING,
    STATUS_RUNNING, STATUS_COMPLETED, STATUS_FAILED,
    BACKOFF_BASE, BACKOFF_MAX, MAX_RETRIES,
    DOC_EXTENSIONS,
    USE_BROWSER, BROWSER_CONCURRENCY, JS_DETECTION_THRESHOLD,
    CrawlResult, ArtifactEntry,
)
from .scopes import build_scope_regex
from .sitemap import SitemapDiscovery
from .pdf_discovery import PDFDiscovery
from .lightweight_scraper import LightweightScraper
from .link_crawler import LinkCrawler
from .browser_fetcher import BrowserFetcher
from .storage import StorageBackend


class CrawlOrchestrator:
    """Orchestrates the full crawl pipeline."""

    def __init__(
        self,
        source_url: str,
        job_id: str = "",
        output_dir: str = "output",
        max_pages: int = 500,
        scope_type: str = "all",
        pdf_scope: str = "",
        doc_scope: str = "",
        include_images: bool = True,
        download_images: bool = False,
        concurrency: int = 0,
        use_browser: str = "auto",
        max_depth: int = 0,
    ):
        # Normalize: ensure path ends with / without mangling query params
        _p = urlparse(source_url)
        self.source_url = urlunparse(_p._replace(path=_p.path.rstrip("/") + "/"))
        self.job_id = job_id or self._make_job_id(source_url)
        self.output_dir = output_dir
        self.max_pages = max_pages
        self.max_depth = max_depth or MAX_DEPTH
        self.scope_type = scope_type
        # For PDF/doc scope: default to "all" when scope_type=none, otherwise same as scope_type
        effective_default = "all" if scope_type == "none" else scope_type
        self.pdf_scope = pdf_scope or effective_default
        self.doc_scope = doc_scope or effective_default
        self.include_images = include_images
        self.download_images = download_images
        self.concurrency = concurrency or MAX_CONCURRENT
        self.use_browser = use_browser
        self.storage = StorageBackend(output_dir, self.job_id)
        self.started_at = datetime.now(timezone.utc).isoformat()

        self._browser_fetcher: Optional[BrowserFetcher] = None
        self._pdf_results: List[CrawlResult] = []
        self._doc_results: List[CrawlResult] = []
        self._image_results: List[CrawlResult] = []
        self._downloaded_urls: Set[str] = set()  # Track downloaded PDF URLs for dedup
        self._downloaded_doc_urls: Set[str] = set()  # Track downloaded doc URLs for dedup
        self._downloaded_image_urls: Set[str] = set()  # Track downloaded image URLs for dedup
        self._bfs_saved: Set[str] = set()  # Track URLs saved during BFS (dedup with Phase 2)

    @staticmethod
    def _make_job_id(url: str) -> str:
        p = urlparse(url)
        host = p.netloc.replace(".", "-")
        ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        short_id = uuid.uuid4().hex[:8]
        return f"{host}_{ts}_{short_id}"

    # -- Signal handler for graceful failure --

    def _on_signal(self, signum):
        """Handle SIGTERM/SIGINT — write FAILED status to S3 and exit."""
        sig_name = signal.Signals(signum).name
        print(f"\n  [SIGNAL] Received {sig_name} — writing FAILED status and exiting")
        try:
            self.storage.write_status(
                self.source_url, STATUS_FAILED, "SIGNAL",
                error=f"Process terminated ({sig_name})",
                started_at=self.started_at,
            )
        except Exception:
            pass  # Best-effort; process is dying
        sys.exit(128 + signum)

    # -- Heartbeat: detect silent deaths (OOM, freeze) --

    _heartbeat_task: Optional[asyncio.Task] = None
    _current_phase: str = ""
    _last_progress: Optional[Dict] = None

    async def _heartbeat_loop(self):
        """Background task — writes status.json every 60s so we detect silent OOM/crash."""
        while True:
            await asyncio.sleep(60)
            try:
                self.storage.write_status(
                    self.source_url, STATUS_RUNNING,
                    self._current_phase or "HEARTBEAT",
                    started_at=self.started_at,
                    progress=self._last_progress,
                )
            except Exception:
                pass  # Best-effort

    def _start_heartbeat(self):
        if not self._heartbeat_task:
            self._heartbeat_task = asyncio.ensure_future(self._heartbeat_loop())

    def _stop_heartbeat(self):
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None

    # -- Progress callback helpers --

    def _discovery_progress(self, progress: dict):
        """Called by LinkCrawler after each BFS chunk."""
        self._current_phase = PHASE_DISCOVERING
        self._last_progress = progress
        self.storage.write_status(
            self.source_url, STATUS_RUNNING, PHASE_DISCOVERING,
            started_at=self.started_at,
            progress=progress,
        )

    def _scraping_progress(self, progress: dict):
        """Called by LightweightScraper after each batch."""
        self._current_phase = PHASE_SCRAPING
        self._last_progress = progress
        self.storage.write_status(
            self.source_url, STATUS_RUNNING, PHASE_SCRAPING,
            started_at=self.started_at,
            progress=progress,
        )

    # -- BFS page callback: save markdown to S3 during discovery --

    def _save_bfs_page(self, url: str, html: str):
        """Called for each browser-rendered page during BFS — saves markdown to S3 immediately."""
        if url in self._bfs_saved or not html or len(html) < 50:
            return
        self._bfs_saved.add(url)

        import html2text
        import re
        h2t = html2text.HTML2Text()
        h2t.ignore_links = False
        h2t.ignore_images = not self.include_images
        h2t.body_width = 0

        md = h2t.handle(html)
        md = re.sub(r"\n{4,}", "\n\n\n", md)
        if not md or len(md.strip()) < 10:
            return

        # Extract title
        m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
        title = m.group(1).strip() if m else ""

        fname = hashlib.md5(url.encode()).hexdigest() + ".md"
        parsed = urlparse(url)

        stored = self.storage.save_text(
            "all", "markdown", fname, md,
            content_type="text/markdown",
        )
        self.storage.record_artifact(ArtifactEntry(
            type="markdown", source_url=url, s3_key=stored,
            size_bytes=len(md.encode("utf-8")),
        ))

        now = datetime.now(timezone.utc).isoformat()
        meta = {
            "source_url": url, "scope": "all",
            "content_type": "markdown", "document_id": hashlib.md5(url.encode()).hexdigest(),
            "title": title, "domain": parsed.netloc, "path": parsed.path,
            "word_count": len(md.split()), "char_count": len(md),
            "crawled_at": now, "stored_path": stored,
        }
        self.storage.save_text(
            "all", "metadata",
            f"{fname}.metadata.json",
            json.dumps(meta, indent=2),
            content_type="application/json",
        )

    # -- PDF download helpers --

    @staticmethod
    def _pdf_id(url: str) -> str:
        return hashlib.md5(url.encode()).hexdigest()

    # Browser-like headers — prevents 403 from servers that block raw HTTP clients
    _DL_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    async def _fetch_with_backoff(self, client: httpx.AsyncClient, url: str) -> Optional[httpx.Response]:
        for attempt in range(MAX_RETRIES):
            try:
                r = await client.get(url, follow_redirects=True, timeout=180)
                if r.status_code in (429, 503):
                    wait = min(BACKOFF_BASE ** (attempt + 1) + random.uniform(0, 1), BACKOFF_MAX)
                    print(f"  [PDF] {r.status_code} on {url[:60]}, retry in {wait:.1f}s")
                    await asyncio.sleep(wait)
                    continue
                return r
            except Exception as e:
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(BACKOFF_BASE ** attempt)
                else:
                    print(f"  [PDF] Fetch failed after {MAX_RETRIES} attempts: {url[:60]}: {e}")
        return None

    async def _download_one_pdf(self, url: str, sem: asyncio.Semaphore):
        """Download a single PDF (with dedup). Falls back to browser on 403."""
        if url in self._downloaded_urls:
            return
        self._downloaded_urls.add(url)

        async with sem:
            try:
                data = None
                ct = ""

                # Try httpx first (fast, lightweight)
                async with httpx.AsyncClient(follow_redirects=True, timeout=180, headers=self._DL_HEADERS) as client:
                    r = await self._fetch_with_backoff(client, url)
                    if r is not None and r.status_code == 200:
                        ct = r.headers.get("content-type", "")
                        path_low = urlparse(url).path.lower()
                        if "pdf" in ct or path_low.endswith(".pdf"):
                            data = r.content
                    elif r is not None and r.status_code in (403, 401):
                        # Server blocked plain HTTP — try browser fallback
                        if self._browser_fetcher:
                            result = await self._browser_fetcher.download_bytes(url)
                            if result:
                                data, ct = result
                            else:
                                print(f"  [PDF] SKIP (HTTP {r.status_code}, browser fallback failed) {url[:80]}")
                                return
                        else:
                            print(f"  [PDF] SKIP (HTTP {r.status_code}) {url[:80]}")
                            return
                    elif r is not None:
                        print(f"  [PDF] SKIP (HTTP {r.status_code}) {url[:80]}")
                        return
                    else:
                        print(f"  [PDF] SKIP (fetch failed) {url[:80]}")
                        return

                if not data:
                    print(f"  [PDF] SKIP (empty response) {url[:80]}")
                    return

                parsed = urlparse(url)
                filename = Path(parsed.path).name
                if not filename.lower().endswith(".pdf"):
                    filename = f"{self._pdf_id(url)}.pdf"

                stored = self.storage.save_bytes(
                    "pdfs", "", filename, data,
                    content_type="application/pdf",
                )

                now = datetime.now(timezone.utc).isoformat()
                meta = {
                    "source_url": url, "scope": "all",
                    "content_type": "pdf", "document_id": self._pdf_id(url),
                    "file_size_bytes": len(data), "domain": parsed.netloc,
                    "crawled_at": now, "stored_path": stored,
                }
                self.storage.save_text(
                    "pdfs", "metadata",
                    f"{filename}.metadata.json",
                    json.dumps(meta, indent=2),
                    content_type="application/json",
                )

                self.storage.record_artifact(ArtifactEntry(
                    type="pdf", source_url=url, s3_key=stored,
                    size_bytes=len(data),
                ))

                size_mb = len(data) / (1024 * 1024)
                self._pdf_results.append(CrawlResult(
                    url=url, scope="all", title=filename,
                    word_count=0, char_count=len(data), content_type="pdf",
                    file_path=stored, crawled_at=now, domain=parsed.netloc,
                ))
                print(f"  [PDF] {filename} ({size_mb:.1f} MB)")

            except Exception as e:
                print(f"  [PDF] Error {url[:60]}: {e}")

    async def _download_all_pdfs(self, pdf_urls: Set[str]):
        """Download all PDFs with concurrency control."""
        urls = list(pdf_urls)
        if not urls:
            print("  [PDF] No PDFs to download")
            return

        print(f"  [PDF] Downloading {len(urls)} PDFs...")
        sem = asyncio.Semaphore(self.concurrency)

        for i in range(0, len(urls), 20):
            chunk = urls[i:i + 20]
            await asyncio.gather(
                *(self._download_one_pdf(u, sem) for u in chunk),
                return_exceptions=True,
            )
            done = min(i + 20, len(urls))
            print(f"  [PDF] {done}/{len(urls)} processed ({len(self._pdf_results)} downloaded)")

        print(f"  [PDF] Complete: {len(self._pdf_results)} PDFs downloaded")

    # -- Image download helpers --

    async def _download_one_image(self, url: str, sem: asyncio.Semaphore):
        """Download a single image (with dedup)."""
        if url in self._downloaded_image_urls:
            return
        self._downloaded_image_urls.add(url)

        async with sem:
            try:
                async with httpx.AsyncClient(follow_redirects=True, timeout=60, headers=self._DL_HEADERS) as client:
                    r = await client.get(url, follow_redirects=True, timeout=60)
                    if r.status_code != 200:
                        return

                    data = r.content
                    if len(data) < 100:  # Skip tiny/broken images
                        return

                    parsed = urlparse(url)
                    filename = Path(parsed.path).name
                    if not filename or '.' not in filename:
                        ext = r.headers.get("content-type", "").split("/")[-1].split(";")[0]
                        filename = f"{hashlib.md5(url.encode()).hexdigest()}.{ext or 'jpg'}"

                    stored = self.storage.save_bytes(
                        "images", "", filename, data,
                        content_type=r.headers.get("content-type", "image/jpeg"),
                    )

                    self.storage.record_artifact(ArtifactEntry(
                        type="image", source_url=url, s3_key=stored,
                        size_bytes=len(data),
                    ))

                    self._image_results.append(CrawlResult(
                        url=url, scope="all", title=filename,
                        word_count=0, char_count=len(data), content_type="image",
                        file_path=stored,
                        crawled_at=datetime.now(timezone.utc).isoformat(),
                        domain=parsed.netloc,
                    ))

            except Exception as e:
                print(f"  [IMAGE] Error {url[:60]}: {e}")

    async def _download_all_images(self, image_urls: Set[str]):
        """Download all images with concurrency control."""
        urls = list(image_urls)
        if not urls:
            print("  [IMAGE] No images to download")
            return

        print(f"  [IMAGE] Downloading {len(urls)} images...")
        sem = asyncio.Semaphore(self.concurrency)

        for i in range(0, len(urls), 50):
            chunk = urls[i:i + 50]
            await asyncio.gather(
                *(self._download_one_image(u, sem) for u in chunk),
                return_exceptions=True,
            )
            done = min(i + 50, len(urls))
            print(f"  [IMAGE] {done}/{len(urls)} processed ({len(self._image_results)} downloaded)")

        print(f"  [IMAGE] Complete: {len(self._image_results)} images downloaded")

    # -- Doc download helpers --

    @staticmethod
    def _doc_id(url: str) -> str:
        return hashlib.md5(url.encode()).hexdigest()

    async def _download_one_doc(self, url: str, sem: asyncio.Semaphore):
        """Download a single office document (with dedup). Falls back to browser on 403."""
        if url in self._downloaded_doc_urls:
            return
        self._downloaded_doc_urls.add(url)

        async with sem:
            try:
                data = None

                # Try httpx first (fast, lightweight)
                async with httpx.AsyncClient(follow_redirects=True, timeout=180, headers=self._DL_HEADERS) as client:
                    r = await self._fetch_with_backoff(client, url)
                    if r is not None and r.status_code == 200:
                        # Verify it's a document by extension or content-type
                        path_lower = urlparse(url).path.lower()
                        has_doc_ext = any(path_lower.endswith(ext) for ext in DOC_EXTENSIONS)
                        if not has_doc_ext:
                            ct = r.headers.get("content-type", "").lower()
                            doc_types = ("msword", "officedocument", "opendocument",
                                         "ms-excel", "ms-powerpoint", "spreadsheet", "presentation",
                                         "application/octet-stream")
                            if not any(dt in ct for dt in doc_types):
                                print(f"  [DOC] SKIP (not a doc, content-type={ct[:40]}) {url[:80]}")
                                return
                        data = r.content
                    elif r is not None and r.status_code in (403, 401):
                        # Server blocked plain HTTP — try browser fallback
                        if self._browser_fetcher:
                            result = await self._browser_fetcher.download_bytes(url)
                            if result:
                                data, _ = result
                            else:
                                print(f"  [DOC] SKIP (HTTP {r.status_code}, browser fallback failed) {url[:80]}")
                                return
                        else:
                            print(f"  [DOC] SKIP (HTTP {r.status_code}) {url[:80]}")
                            return
                    elif r is not None:
                        print(f"  [DOC] SKIP (HTTP {r.status_code}) {url[:80]}")
                        return
                    else:
                        print(f"  [DOC] SKIP (fetch failed) {url[:80]}")
                        return

                if not data:
                    print(f"  [DOC] SKIP (empty response) {url[:80]}")
                    return

                parsed = urlparse(url)
                filename = Path(parsed.path).name
                if not any(filename.lower().endswith(ext) for ext in DOC_EXTENSIONS):
                    filename = f"{self._doc_id(url)}.docx"

                stored = self.storage.save_bytes(
                    "docs", "", filename, data,
                    content_type="application/octet-stream",
                )

                now = datetime.now(timezone.utc).isoformat()
                meta = {
                    "source_url": url, "scope": "all",
                    "content_type": "doc", "document_id": self._doc_id(url),
                    "file_size_bytes": len(data), "domain": parsed.netloc,
                    "crawled_at": now, "stored_path": stored,
                }
                self.storage.save_text(
                    "docs", "metadata",
                    f"{filename}.metadata.json",
                    json.dumps(meta, indent=2),
                    content_type="application/json",
                )

                self.storage.record_artifact(ArtifactEntry(
                    type="doc", source_url=url, s3_key=stored,
                    size_bytes=len(data),
                ))

                size_mb = len(data) / (1024 * 1024)
                self._doc_results.append(CrawlResult(
                    url=url, scope="all", title=filename,
                    word_count=0, char_count=len(data), content_type="doc",
                    file_path=stored, crawled_at=now, domain=parsed.netloc,
                ))
                print(f"  [DOC] {filename} ({size_mb:.1f} MB)")

            except Exception as e:
                print(f"  [DOC] Error {url[:60]}: {e}")

    async def _download_all_docs(self, doc_urls: Set[str]):
        """Download all office documents with concurrency control."""
        urls = list(doc_urls)
        if not urls:
            print("  [DOC] No documents to download")
            return

        print(f"  [DOC] Downloading {len(urls)} documents...")
        sem = asyncio.Semaphore(self.concurrency)

        for i in range(0, len(urls), 20):
            chunk = urls[i:i + 20]
            await asyncio.gather(
                *(self._download_one_doc(u, sem) for u in chunk),
                return_exceptions=True,
            )
            done = min(i + 20, len(urls))
            print(f"  [DOC] {done}/{len(urls)} processed ({len(self._doc_results)} downloaded)")

        print(f"  [DOC] Complete: {len(self._doc_results)} documents downloaded")

    # -- Main pipeline --

    async def run(self) -> Dict:
        print("=" * 70)
        print("  WEB CRAWLER v4 (Lightweight)")
        print(f"  URL:         {self.source_url}")
        print(f"  Job ID:      {self.job_id}")
        print(f"  Storage:     {'S3 (' + S3_BUCKET + ')' if USE_S3 else 'Local (' + self.output_dir + ')'}")
        print(f"  Concurrency: {self.concurrency}")
        print(f"  Max pages:   {self.max_pages}")
        print(f"  Page scope:  {self.scope_type}" + (" (markdown skipped)" if self.scope_type == "none" else ""))
        print(f"  PDF scope:   {self.pdf_scope}")
        print(f"  DOC scope:   {self.doc_scope}")
        print(f"  Images:      {'inline in markdown' if self.include_images else 'excluded'}")
        print(f"  Download images: {'yes' if self.download_images else 'no'}")
        print(f"  Browser:     {self.use_browser}")
        print("=" * 70)

        try:
            # Register signal handlers for graceful failure (ECS sends SIGTERM before SIGKILL)
            try:
                loop = asyncio.get_running_loop()
                for sig in (signal.SIGTERM, signal.SIGINT):
                    loop.add_signal_handler(sig, self._on_signal, sig)
            except (NotImplementedError, OSError):
                pass  # Windows or restricted environments

            # Start heartbeat (writes status.json every 60s to detect silent crashes)
            self._start_heartbeat()

            # ---- Launch browser early if --use-browser=on ----
            if self.use_browser == "on" and not self._browser_fetcher:
                print(f"\n  [BROWSER] --use-browser=on — launching browser for all phases")
                self._browser_fetcher = BrowserFetcher(BROWSER_CONCURRENCY)
                await self._browser_fetcher.start()

            # ---- Phase 1: SITEMAP DISCOVERY ----
            self.storage.write_status(
                self.source_url, STATUS_RUNNING, PHASE_DISCOVERING,
                started_at=self.started_at,
                progress={"step": "sitemap_discovery"},
            )
            print(f"\n[PHASE 1] Sitemap Discovery")
            print("-" * 40)
            sm = SitemapDiscovery(self.source_url)
            entries = await sm.discover()
            sm_urls = [e.url for e in entries]
            print(f"  Found {len(sm_urls)} sitemap URLs")

            # Update status with sitemap result
            self.storage.write_status(
                self.source_url, STATUS_RUNNING, PHASE_DISCOVERING,
                started_at=self.started_at,
                progress={"step": "sitemap_complete", "sitemap_urls": len(sm_urls)},
            )

            # PDF/doc URLs discovered during BFS (empty if sitemap was found)
            bfs_pdfs: Set[str] = set()
            bfs_docs: Set[str] = set()

            # ---- Phase 1b: BFS LINK CRAWL FALLBACK ----
            if len(sm_urls) == 0:
                print(f"\n[PHASE 1b] No sitemap found — falling back to BFS link crawl")
                print("-" * 40)

                # page_callback saves markdown to S3 during BFS (when browser renders pages)
                bfs_page_cb = self._save_bfs_page if self._browser_fetcher else None
                link_crawler = LinkCrawler(
                    source_url=self.source_url,
                    scope_type=self.scope_type if self.scope_type != "none" else "all",
                    max_pages=self.max_pages,
                    max_depth=self.max_depth,
                    concurrency=self.concurrency,
                    browser_fetcher=self._browser_fetcher,
                    status_callback=self._discovery_progress,
                    page_callback=bfs_page_cb,
                )
                sm_urls = await link_crawler.crawl()
                # Collect PDF/doc URLs found during BFS
                bfs_pdfs = link_crawler.discovered_pdfs
                bfs_docs = link_crawler.discovered_docs

                # Auto-detect: if BFS found very few links, site is likely JS-rendered
                if (self.use_browser == "auto"
                        and len(sm_urls) <= JS_DETECTION_THRESHOLD
                        and not self._browser_fetcher):
                    print(f"\n[PHASE 1b+] Detected JavaScript-rendered site "
                          f"({len(sm_urls)} links found) — retrying with browser")
                    print("-" * 40)
                    self._browser_fetcher = BrowserFetcher(BROWSER_CONCURRENCY)
                    await self._browser_fetcher.start()
                    link_crawler2 = LinkCrawler(
                        source_url=self.source_url,
                        scope_type=self.scope_type if self.scope_type != "none" else "all",
                        max_pages=self.max_pages,
                        max_depth=self.max_depth,
                        concurrency=self.concurrency,
                        browser_fetcher=self._browser_fetcher,
                        status_callback=self._discovery_progress,
                        page_callback=self._save_bfs_page,
                    )
                    sm_urls = await link_crawler2.crawl()
                    bfs_pdfs |= link_crawler2.discovered_pdfs
                    bfs_docs |= link_crawler2.discovered_docs

                if bfs_pdfs or bfs_docs:
                    print(f"  BFS discovered: {len(bfs_pdfs)} PDFs, {len(bfs_docs)} docs")

            # Filter pages by scope (if not "all" and not "none")
            if self.scope_type not in ("all", "none"):
                page_filter = build_scope_regex(self.source_url, self.scope_type)
                sm_urls_filtered = [u for u in sm_urls if page_filter.match(u)]
                print(f"  Filtered to {len(sm_urls_filtered)} URLs matching scope '{self.scope_type}'")
            else:
                sm_urls_filtered = sm_urls

            # Cap to max_pages
            scrape_urls = sm_urls_filtered[:self.max_pages]
            if self.scope_type == "none":
                print(f"  Markdown: SKIPPED (scope_type=none)")
                print(f"  Pages available for document discovery: {len(sm_urls)}")
            else:
                print(f"  Will scrape {len(scrape_urls)} pages")

            # ---- Phase 1.5: DOCUMENT DISCOVERY (PDF + docs) ----
            discovered_pdfs: Set[str] = set()
            discovered_docs: Set[str] = set()
            skip_pdf = self.pdf_scope == "none"
            skip_doc = self.doc_scope == "none"

            # Merge any PDFs/docs found during BFS link discovery
            if not skip_pdf and bfs_pdfs:
                discovered_pdfs.update(bfs_pdfs)
            if not skip_doc and bfs_docs:
                discovered_docs.update(bfs_docs)

            if skip_pdf and skip_doc:
                print(f"\n[PHASE 1.5] Document Discovery — SKIPPED (pdf_scope=none, doc_scope=none)")
                print("-" * 40)
            else:
                self.storage.write_status(
                    self.source_url, STATUS_RUNNING, PHASE_PDF_DISCOVERY,
                    started_at=self.started_at,
                )
                from .pdf_discovery import PDFDiscovery

                # Determine which file types to scan for
                file_types: Set[str] = set()
                if not skip_pdf:
                    file_types.add("pdf")
                if not skip_doc:
                    file_types.add("doc")

                # Use the broadest scope between pdf_scope and doc_scope
                discovery_scope = self.pdf_scope if not skip_pdf else self.doc_scope
                mode = "browser cache + Content-Type probing" if self._browser_fetcher else "lightweight HTTP scan"
                print(f"\n[PHASE 1.5] Document Discovery ({mode})")
                print("-" * 40)
                if discovered_pdfs or discovered_docs:
                    print(f"  BFS found: {len(discovered_pdfs)} PDFs, {len(discovered_docs)} docs")
                if skip_pdf:
                    print(f"  PDFs: SKIPPED (pdf_scope=none)")
                if skip_doc:
                    print(f"  Docs: SKIPPED (doc_scope=none)")

                # Full discovery: extract links from pages + Content-Type probing
                # for ambiguous URLs (no file extension). Works for any CMS/server.
                # When browser_fetcher is set, uses cached HTML + browser-based probing.
                doc_disc = PDFDiscovery(
                    self.source_url, sm_urls,
                    scope_type=discovery_scope,
                    file_types=file_types,
                    browser_fetcher=self._browser_fetcher,
                )
                disc_result = await doc_disc.discover()
                # Merge with any PDFs/docs found during BFS
                discovered_pdfs.update(disc_result.get("pdf", set()))
                discovered_docs.update(disc_result.get("doc", set()))

            # ---- Phase 2: SCRAPING + DOWNLOADS (in parallel) ----
            # Skip URLs already saved during BFS (browser mode saves markdown during discovery)
            if self._bfs_saved:
                before = len(scrape_urls)
                scrape_urls = [u for u in scrape_urls if u not in self._bfs_saved]
                skipped = before - len(scrape_urls)
                if skipped:
                    print(f"  [BFS] {skipped} pages already saved to S3 during BFS discovery — skipping in Phase 2")

            self.storage.write_status(
                self.source_url, STATUS_RUNNING, PHASE_SCRAPING,
                started_at=self.started_at,
            )

            scraper = None
            extra_pdfs: Set[str] = set()
            extra_docs: Set[str] = set()

            if self.scope_type == "none":
                # No markdown saved, but still scrape pages for PDF/doc link discovery
                print(f"\n[PHASE 2] Scraping (no markdown) + Downloads")
                print("-" * 40)
                print(f"  Markdown: SKIPPED (scope_type=none)")

                # Run scraper with save_markdown=False to discover additional PDF/doc links
                scraper = LightweightScraper(
                    urls=scrape_urls,
                    storage=self.storage,
                    concurrency=self.concurrency,
                    scope_name="all",
                    include_images=False,
                    save_markdown=False,
                    browser_fetcher=self._browser_fetcher,
                    status_callback=self._scraping_progress,
                )

                parallel_tasks = [scraper.run()]
                if not skip_pdf and discovered_pdfs:
                    parallel_tasks.append(self._download_all_pdfs(discovered_pdfs))
                if not skip_doc and discovered_docs:
                    parallel_tasks.append(self._download_all_docs(discovered_docs))

                parts = [f"scanning {len(scrape_urls)} pages for links"]
                if not skip_pdf and discovered_pdfs:
                    parts.append(f"{len(discovered_pdfs)} PDFs")
                if not skip_doc and discovered_docs:
                    parts.append(f"{len(discovered_docs)} docs")
                print(f"  Launching: {' + '.join(parts)}")
                await asyncio.gather(*parallel_tasks)
            else:
                print(f"\n[PHASE 2] Scraping + Downloads (in parallel)")
                print("-" * 40)

                scraper = LightweightScraper(
                    urls=scrape_urls,
                    storage=self.storage,
                    concurrency=self.concurrency,
                    scope_name="all",
                    include_images=self.include_images,
                    browser_fetcher=self._browser_fetcher,
                    status_callback=self._scraping_progress,
                )

                # Build parallel tasks
                parallel_tasks = [scraper.run()]
                if not skip_pdf and discovered_pdfs:
                    parallel_tasks.append(self._download_all_pdfs(discovered_pdfs))
                if not skip_doc and discovered_docs:
                    parallel_tasks.append(self._download_all_docs(discovered_docs))

                parts = [f"{len(scrape_urls)} pages"]
                if not skip_pdf:
                    parts.append(f"{len(discovered_pdfs)} PDFs")
                if not skip_doc:
                    parts.append(f"{len(discovered_docs)} docs")
                print(f"  Launching: {' + '.join(parts)}")
                await asyncio.gather(*parallel_tasks)

            # ---- Phase 2.5: EXTRA DOWNLOADS found during scraping ----
            if scraper is not None:
                if not skip_pdf:
                    extra_pdfs = scraper.discovered_pdfs - discovered_pdfs - self._downloaded_urls
                    if extra_pdfs:
                        print(f"\n[PHASE 2.5] Downloading {len(extra_pdfs)} additional PDFs found during scraping")
                        print("-" * 40)
                        await self._download_all_pdfs(extra_pdfs)

                if not skip_doc:
                    extra_docs = scraper.discovered_docs - discovered_docs - self._downloaded_doc_urls
                    if extra_docs:
                        print(f"\n[PHASE 2.5] Downloading {len(extra_docs)} additional docs found during scraping")
                        print("-" * 40)
                        await self._download_all_docs(extra_docs)

                # ---- Phase 2.6: IMAGE DOWNLOAD (if requested) ----
                if self.download_images and scraper.discovered_images:
                    print(f"\n[PHASE 2.6] Downloading {len(scraper.discovered_images)} images")
                    print("-" * 40)
                    await self._download_all_images(scraper.discovered_images)

            # Free browser HTML cache after scraping (no longer needed)
            if self._browser_fetcher:
                self._browser_fetcher.clear_cache()

            # ---- Phase 3: REPORTS ----
            self.storage.write_status(
                self.source_url, STATUS_RUNNING, PHASE_UPLOADING,
                started_at=self.started_at,
            )
            print(f"\n[PHASE 3] Reports & Manifest")
            print("-" * 40)

            scraper_results = scraper.results if scraper else []
            all_res = scraper_results + self._pdf_results + self._doc_results + self._image_results
            rows = [{
                "url": r.url, "scope": r.scope, "title": r.title,
                "summary": r.summary, "content_type": r.content_type,
                "word_count": r.word_count, "char_count": r.char_count,
                "price": r.price or "", "domain": r.domain,
                "crawled_at": r.crawled_at, "file_path": r.file_path,
            } for r in all_res]

            csv_path = self.storage.save_csv(rows, "crawl_report.csv")
            print(f"  CSV: {csv_path} ({len(rows)} rows)")

            self.storage.write_manifest(self.source_url)
            print(f"  Manifest: manifest.json ({len(self.storage._artifacts)} artifacts)")

            # Build summary
            completed_at = datetime.now(timezone.utc).isoformat()
            md_count = sum(1 for r in all_res if r.content_type == "markdown")
            pdf_count = sum(1 for r in all_res if r.content_type == "pdf")
            doc_count = sum(1 for r in all_res if r.content_type == "doc")
            image_count = sum(1 for r in all_res if r.content_type == "image")

            summary = {
                "jobId": self.job_id,
                "source_url": self.source_url,
                "page_scope": self.scope_type,
                "pdf_scope": self.pdf_scope,
                "doc_scope": self.doc_scope,
                "download_images": self.download_images,
                "use_browser": self.use_browser,
                "browser_activated": self._browser_fetcher is not None,
                "started_at": self.started_at,
                "completed_at": completed_at,
                "totals": {
                    "pages": len(all_res),
                    "markdown": md_count,
                    "pdfs": pdf_count,
                    "docs": doc_count,
                    "images": image_count,
                    "images_discovered": len(scraper.discovered_images) if scraper else 0,
                    "pdfs_discovered_phase1_5": len(discovered_pdfs),
                    "docs_discovered_phase1_5": len(discovered_docs),
                    "pdfs_discovered_during_scraping": len(scraper.discovered_pdfs) if scraper else 0,
                    "docs_discovered_during_scraping": len(scraper.discovered_docs) if scraper else 0,
                    "pdfs_extra_from_scraping": len(extra_pdfs),
                    "docs_extra_from_scraping": len(extra_docs),
                    "sitemap_urls": len(sm_urls),
                    "pages_scraped": len(scraper.visited) if scraper else 0,
                },
            }
            self.storage.save_text(
                "", "", "job_summary.json",
                json.dumps(summary, indent=2),
                content_type="application/json",
            )

            # ---- COMPLETED ----
            self.storage.write_status(
                self.source_url, STATUS_COMPLETED, PHASE_UPLOADING,
                started_at=self.started_at,
            )

            print("\n" + "=" * 70)
            print("  CRAWL COMPLETE")
            print("=" * 70)
            loc = f"s3://{S3_BUCKET}/jobs/{self.job_id}/" if USE_S3 else f"{self.output_dir}/{self.job_id}/"
            print(f"  Output:    {loc}")
            t = summary["totals"]
            print(f"  Markdown:  {t['markdown']} pages scraped")
            print(f"  PDFs:      {t['pdfs']} downloaded (of {t['pdfs_discovered_phase1_5']} discovered + {t['pdfs_extra_from_scraping']} from scraping)")
            print(f"  Docs:      {t['docs']} downloaded (of {t['docs_discovered_phase1_5']} discovered + {t['docs_extra_from_scraping']} from scraping)")
            print(f"  Images:    {t['images']} downloaded (of {t['images_discovered']} discovered)")
            print(f"  Total:     {t['pages']} artifacts")

            # Calculate duration
            start = datetime.fromisoformat(self.started_at)
            end = datetime.fromisoformat(completed_at)
            duration = (end - start).total_seconds()
            if self._browser_fetcher:
                print(f"  Browser:   activated (JS rendering)")
            print(f"  Duration:  {duration / 60:.1f} minutes")
            print("=" * 70)

            return summary

        except Exception as e:
            self.storage.write_status(
                self.source_url, STATUS_FAILED, "ERROR",
                error=str(e), started_at=self.started_at,
                progress={"artifactCount": len(self.storage._artifacts)},
            )
            print(f"\n  CRAWL FAILED: {e}")
            raise
        finally:
            self._stop_heartbeat()
            # Always cleanup browser (on success, failure, or signal)
            if self._browser_fetcher:
                try:
                    await self._browser_fetcher.close()
                except Exception:
                    pass


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Lightweight web crawler")
    p.add_argument("--url", type=str, help="URL to crawl")
    p.add_argument("--config", type=str, help="YAML config file")
    p.add_argument("--job-id", type=str, default="")
    p.add_argument("--output", type=str, default="output")
    p.add_argument("--max-pages", type=int, default=500, help="Max pages to scrape")
    p.add_argument("--no-limit", action="store_true",
                    help="Scrape all sitemap pages (up to NO_LIMIT_MAX_PAGES, default 99999)")
    p.add_argument("--scope-type", type=str, default="all",
                    choices=["path", "host", "subdomains", "all", "none"],
                    help="Scope for page scraping ('none' to skip markdown, only download PDFs/docs)")
    p.add_argument("--pdf-scope", type=str, default="",
                    choices=["path", "host", "subdomains", "all", "none", ""],
                    help="Scope for PDF discovery (default: same as --scope-type, 'none' to skip PDFs)")
    p.add_argument("--doc-scope", type=str, default="",
                    choices=["path", "host", "subdomains", "all", "none", ""],
                    help="Scope for office doc discovery (default: same as --scope-type, 'none' to skip docs)")
    p.add_argument("--include-images", action="store_true", default=True,
                    help="Include image references inline in markdown (default: on)")
    p.add_argument("--no-images", action="store_true",
                    help="Exclude image references from markdown output")
    p.add_argument("--download-images", action="store_true",
                    help="Download images to S3/local storage (default: off)")
    p.add_argument("--use-browser", type=str, default="auto",
                    choices=["auto", "on", "off"],
                    help="Browser rendering: auto=detect JS sites, on=always, off=never (default: auto)")
    p.add_argument("--concurrency", type=int, default=0)
    return p.parse_args()


async def from_config(path: str, out: str, scope_type: str = "all", pdf_scope: str = "",
                      doc_scope: str = "", include_images: bool = True, download_images: bool = False,
                      use_browser: str = "auto"):
    with open(path) as f:
        cfg = yaml.safe_load(f)
    for job in cfg.get("crawl_jobs", []):
        c = CrawlOrchestrator(
            source_url=job["source_url"],
            job_id=job.get("name", ""),
            output_dir=out,
            max_pages=job.get("max_pages", 500),
            max_depth=job.get("max_depth", MAX_DEPTH),
            scope_type=job.get("scope_type", scope_type),
            pdf_scope=job.get("pdf_scope", pdf_scope),
            doc_scope=job.get("doc_scope", doc_scope),
            include_images=job.get("include_images", include_images),
            download_images=job.get("download_images", download_images),
            use_browser=job.get("use_browser", use_browser),
        )
        await c.run()


async def main():
    args = parse_args()

    url = args.url or SEED_URL
    job_id = args.job_id or JOB_ID
    cfg_path = args.config or os.getenv("CONFIG_PATH", "")
    scope_type = args.scope_type if args.scope_type != "all" else SCOPE_TYPE
    pdf_scope = args.pdf_scope or PDF_SCOPE  # Empty string = same as scope_type
    doc_scope = args.doc_scope or DOC_SCOPE  # Empty string = same as scope_type
    include_images = INCLUDE_IMAGES if not args.no_images else False
    download_images = args.download_images or DOWNLOAD_IMAGES
    use_browser = args.use_browser if args.use_browser != "auto" else USE_BROWSER
    no_limit = args.no_limit or os.getenv("NO_LIMIT", "false").lower() == "true"
    max_pages = NO_LIMIT_MAX_PAGES if no_limit else (args.max_pages if args.max_pages != 500 else MAX_PAGES)
    max_depth = NO_LIMIT_MAX_DEPTH if no_limit else MAX_DEPTH

    if url:
        await CrawlOrchestrator(
            source_url=url,
            job_id=job_id,
            output_dir=args.output,
            max_pages=max_pages,
            scope_type=scope_type,
            pdf_scope=pdf_scope,
            doc_scope=doc_scope,
            include_images=include_images,
            download_images=download_images,
            concurrency=args.concurrency,
            use_browser=use_browser,
            max_depth=max_depth,
        ).run()
    elif cfg_path and os.path.exists(cfg_path):
        await from_config(cfg_path, args.output, scope_type, pdf_scope, doc_scope, include_images, download_images, use_browser)
    elif os.path.exists("urls.yaml"):
        await from_config("urls.yaml", args.output, scope_type, pdf_scope, doc_scope, include_images, download_images, use_browser)
    else:
        print('Usage: python -m worker.main --url "https://example.com"')
        print('   or: SEED_URL="https://example.com" python -m worker.main')
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
