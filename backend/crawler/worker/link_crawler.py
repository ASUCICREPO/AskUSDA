"""
Lightweight BFS link crawler using aiohttp.

Fallback for sites with no sitemap: starts from the seed URL, fetches HTML,
extracts <a href> links, filters by scope, and repeats level by level.

Uses the same aiohttp + concurrency patterns as pdf_discovery.py and
lightweight_scraper.py — no headless browser.
"""

import asyncio
import re
from typing import List, Set
from urllib.parse import urlparse, urlunparse, urljoin

import aiohttp

from .config import (
    SKIP_EXT, SKIP_URL_PATTERNS, DOC_EXTENSIONS,
    PDF_CONTENT_TYPES, DOC_CONTENT_TYPES,
)
from .scopes import build_scope_regex

# Extensions that indicate downloadable documents (captured during BFS)
_PDF_EXT = {".pdf"}
_DOC_EXT = set(DOC_EXTENSIONS)


class LinkCrawler:
    """BFS link crawler using lightweight HTTP requests."""

    def __init__(
        self,
        source_url: str,
        scope_type: str = "all",
        max_pages: int = 500,
        max_depth: int = 3,
        concurrency: int = 20,
        browser_fetcher=None,
        status_callback=None,
        page_callback=None,
    ):
        # Normalize: ensure path ends with / without mangling query params
        _p = urlparse(source_url)
        self.source_url = urlunparse(_p._replace(path=_p.path.rstrip("/") + "/"))
        self.scope_type = scope_type
        self.max_pages = max_pages
        self.max_depth = max_depth
        self.concurrency = concurrency
        self.browser_fetcher = browser_fetcher
        self.status_callback = status_callback
        # Called with (url, html) for each rendered page — saves markdown to S3 during BFS
        self.page_callback = page_callback

        # Collect PDF/doc URLs discovered during BFS (not followed, but saved for download)
        self.discovered_pdfs: Set[str] = set()
        self.discovered_docs: Set[str] = set()

        # Build scope filter
        broadest = "subdomains" if scope_type in ("all", "none") else scope_type
        self._scope_filter = build_scope_regex(source_url, broadest)
        self._skip_patterns = [re.compile(p) for p in SKIP_URL_PATTERNS]

    def _is_valid_url(self, url: str) -> bool:
        """Check if URL should be followed."""
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        path_lower = parsed.path.lower()
        if any(path_lower.endswith(ext) for ext in SKIP_EXT):
            return False
        if any(p.search(url) for p in self._skip_patterns):
            return False
        if not self._scope_filter.match(url):
            return False
        return True

    @staticmethod
    def _extract_links(html: str, base_url: str) -> Set[str]:
        """Extract all <a href> links from HTML, resolve to absolute URLs."""
        links: Set[str] = set()
        for m in re.findall(r'<a[^>]+href=["\']([^"\'#]+)', html, re.I):
            try:
                full = urljoin(base_url, m).split("#")[0]
                links.add(full)
            except Exception:
                pass
        return links

    def _classify_by_content_type(self, url: str, content_type: str) -> bool:
        """Check Content-Type header and classify URL as PDF/doc if applicable.

        This is the general-purpose detection — works for ANY URL regardless
        of file extension or CMS platform. Returns True if classified (not a page).
        """
        if not content_type:
            return False
        ct_lower = content_type.lower().split(";")[0].strip()
        if ct_lower in PDF_CONTENT_TYPES:
            self.discovered_pdfs.add(url)
            return True
        if ct_lower in DOC_CONTENT_TYPES:
            self.discovered_docs.add(url)
            return True
        # Catch generic binary download that's actually a PDF (some servers use octet-stream)
        if ct_lower == "application/octet-stream":
            path_lower = urlparse(url).path.lower()
            if path_lower.endswith(".pdf"):
                self.discovered_pdfs.add(url)
                return True
            if any(path_lower.endswith(ext) for ext in _DOC_EXT):
                self.discovered_docs.add(url)
                return True
        return False

    async def _fetch_page(
        self,
        session: aiohttp.ClientSession,
        url: str,
        sem: asyncio.Semaphore,
    ) -> tuple:
        """Fetch a page and return (url, links) or (url, None) on failure."""
        # Use browser fetcher for JS-rendered sites
        # Note: browser_fetcher.fetch_with_links has its own semaphore, no double-lock
        if self.browser_fetcher:
            html, browser_links, content_type = await self.browser_fetcher.fetch_with_links(url)
            # Content-Type detection: if the URL serves a PDF/doc, capture it
            if self._classify_by_content_type(url, content_type):
                return (url, set())
            all_links = browser_links
            if html:
                all_links |= self._extract_links(html, url)
                # Save markdown to S3 immediately during BFS (not just Phase 2)
                if self.page_callback:
                    try:
                        self.page_callback(url, html)
                    except Exception:
                        pass  # Best-effort; don't break BFS
            return (url, all_links)

        for attempt in range(3):
            async with sem:
                try:
                    async with session.get(
                        url,
                        timeout=aiohttp.ClientTimeout(total=20),
                        ssl=False,
                        allow_redirects=True,
                    ) as resp:
                        if resp.status == 200:
                            ct = resp.headers.get("content-type", "")
                            # Content-Type detection: classify non-HTML as PDF/doc
                            if "text/html" not in ct:
                                self._classify_by_content_type(url, ct)
                                return (url, set())
                            html = await resp.text()
                            return (url, self._extract_links(html, url))
                        if resp.status in (429, 503) and attempt < 2:
                            await asyncio.sleep(2 ** (attempt + 1))
                            continue
                        return (url, set())
                except Exception:
                    if attempt < 2:
                        await asyncio.sleep(1)
                        continue
            break
        return (url, set())

    async def crawl(self) -> List[str]:
        """BFS crawl starting from source_url. Returns list of discovered page URLs."""
        discovered: List[str] = []
        visited: Set[str] = set()
        queue: List[str] = [self.source_url]

        print(f"  [LINK CRAWLER] Starting BFS from {self.source_url}")
        print(f"  [LINK CRAWLER] Scope: {self.scope_type}, Max pages: {self.max_pages}, Max depth: {self.max_depth}")

        sem = asyncio.Semaphore(self.concurrency)

        async with aiohttp.ClientSession() as session:
            for depth in range(self.max_depth + 1):
                if not queue or len(discovered) >= self.max_pages:
                    break

                # Dedup and cap the batch
                batch = []
                for u in queue:
                    if u not in visited and len(discovered) + len(batch) < self.max_pages:
                        batch.append(u)
                        visited.add(u)
                if not batch:
                    break

                print(f"  [LINK CRAWLER] Depth {depth}: fetching {len(batch)} pages...")

                # Fetch in chunks — stream results with as_completed()
                next_queue: Set[str] = set()
                for i in range(0, len(batch), 100):
                    chunk = batch[i:i + 100]
                    tasks = [
                        asyncio.ensure_future(self._fetch_page(session, u, sem))
                        for u in chunk
                    ]
                    completed_in_chunk = 0
                    for future in asyncio.as_completed(tasks):
                        try:
                            r = await future
                        except Exception:
                            completed_in_chunk += 1
                            continue
                        if isinstance(r, tuple):
                            url, links = r
                            discovered.append(url)
                            if links:
                                for link in links:
                                    if link.startswith("http"):
                                        # Classify by file extension (universal, zero-cost)
                                        path_lower = urlparse(link).path.lower()
                                        if any(path_lower.endswith(ext) for ext in _PDF_EXT):
                                            self.discovered_pdfs.add(link)
                                            continue
                                        if any(path_lower.endswith(ext) for ext in _DOC_EXT):
                                            self.discovered_docs.add(link)
                                            continue
                                    # No extension match → follow as page; Content-Type
                                    # detection in _fetch_page catches PDFs/docs on fetch
                                    if link not in visited and self._is_valid_url(link):
                                        next_queue.add(link)
                        completed_in_chunk += 1

                        # Update status every 20 pages (streaming, not batch-barrier)
                        if completed_in_chunk % 20 == 0 and self.status_callback:
                            self.status_callback({
                                "bfs_depth": depth,
                                "bfs_max_depth": self.max_depth,
                                "depth_progress": f"{i + completed_in_chunk}/{len(batch)}",
                                "pages_discovered": len(discovered),
                                "queue_size": len(next_queue),
                                "pdfs_found": len(self.discovered_pdfs),
                                "docs_found": len(self.discovered_docs),
                            })

                    # Log after each chunk completes
                    chunk_done = min(i + 100, len(batch))
                    print(f"  [LINK CRAWLER] Depth {depth}: {chunk_done}/{len(batch)} fetched, {len(discovered)} discovered")
                    if self.status_callback:
                        self.status_callback({
                            "bfs_depth": depth,
                            "bfs_max_depth": self.max_depth,
                            "depth_progress": f"{chunk_done}/{len(batch)}",
                            "pages_discovered": len(discovered),
                            "queue_size": len(next_queue),
                            "pdfs_found": len(self.discovered_pdfs),
                            "docs_found": len(self.discovered_docs),
                        })

                queue = list(next_queue)
                doc_info = ""
                if self.discovered_pdfs or self.discovered_docs:
                    doc_info = f", {len(self.discovered_pdfs)} PDFs, {len(self.discovered_docs)} docs found"
                print(f"  [LINK CRAWLER] Depth {depth}: {len(discovered)} URLs found, {len(queue)} in next queue{doc_info}")

        doc_info = ""
        if self.discovered_pdfs or self.discovered_docs:
            doc_info = f" + {len(self.discovered_pdfs)} PDFs + {len(self.discovered_docs)} docs"
        print(f"  [LINK CRAWLER] Complete: {len(discovered)} URLs discovered via BFS{doc_info}")
        return discovered[:self.max_pages]
