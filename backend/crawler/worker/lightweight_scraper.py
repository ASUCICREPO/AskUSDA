"""
Lightweight page scraper using aiohttp + html2text.

Replaces the headless Chrome BFS crawl for Phase 2. Instead of spinning up
a browser and doing BFS at ~9 seconds/page, this fetches all sitemap URLs
with simple HTTP and converts HTML to markdown at ~0.05s/page.

For a 2000-page site this takes ~2 minutes instead of 5+ hours.
"""

import asyncio
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Set
from urllib.parse import urlparse, urljoin

import aiohttp
import html2text

from .config import (
    CrawlResult, ArtifactEntry,
    REQUEST_DELAY, DOC_EXTENSIONS,
    PDF_CONTENT_TYPES, DOC_CONTENT_TYPES,
)
from .storage import StorageBackend


class LightweightScraper:
    """
    Scrapes all given URLs using lightweight HTTP requests + html2text.
    No headless Chrome, no BFS — just fetches the pages and converts to markdown.
    """

    def __init__(
        self,
        urls: List[str],
        storage: StorageBackend,
        concurrency: int = 20,
        scope_name: str = "all",
        include_images: bool = False,
        save_markdown: bool = True,
        browser_fetcher=None,
        status_callback=None,
    ):
        self.urls = list(dict.fromkeys(urls))  # Deduplicate, preserve order
        self.storage = storage
        self.concurrency = concurrency
        self.scope_name = scope_name
        self.save_markdown = save_markdown
        self.browser_fetcher = browser_fetcher
        self.status_callback = status_callback
        self.results: List[CrawlResult] = []
        self.visited: Set[str] = set()
        self.discovered_pdfs: Set[str] = set()  # PDFs found in page HTML during scraping
        self.discovered_docs: Set[str] = set()  # Office docs found in page HTML during scraping
        self.discovered_images: Set[str] = set()  # Images found in page HTML during scraping

        # Configure html2text
        self._h2t = html2text.HTML2Text()
        self._h2t.ignore_links = False
        self._h2t.ignore_images = not include_images
        self._h2t.ignore_emphasis = False
        self._h2t.body_width = 0  # No wrapping
        self._h2t.skip_internal_links = False
        self._h2t.inline_links = True
        self._h2t.protect_links = True

    @staticmethod
    def _id(url: str) -> str:
        return hashlib.md5(url.encode()).hexdigest()

    @staticmethod
    def _fname(url: str) -> str:
        p = urlparse(url)
        n = p.path.strip("/").replace("/", "_")
        if p.query:
            # Use full MD5 of query string to avoid collisions on long/similar queries
            n += "_" + hashlib.md5(p.query.encode()).hexdigest()[:16]
        n = n or "index"
        if len(n) > 150:
            n = n[:100] + "_" + hashlib.md5(n.encode()).hexdigest()[:12]
        return n

    @staticmethod
    def _extract_title(html: str) -> str:
        m = re.search(r"<title[^>]*>([^<]+)</title>", html, re.I)
        return m.group(1).strip() if m else "Untitled"

    @staticmethod
    def _strip_boilerplate(html: str) -> str:
        """Remove common boilerplate HTML elements before conversion."""
        # Remove script, style, nav, footer, header tags and their contents
        for tag in ["script", "style", "nav", "footer", "noscript", "svg"]:
            html = re.sub(
                rf"<{tag}[\s>].*?</{tag}>",
                "",
                html,
                flags=re.DOTALL | re.IGNORECASE,
            )
        return html

    @staticmethod
    def _extract_pdf_links(html: str, base_url: str) -> Set[str]:
        """Extract PDF URLs from HTML by file extension (.pdf)."""
        pdfs: Set[str] = set()
        # Standard href, src, and common data attributes
        for m in re.findall(
            r'(?:href|src|data-href|data-url|data-src|data-download|data-file|action)'
            r'=["\']([^"\'#]*\.pdf[^"\'#]*)',
            html, re.I,
        ):
            try:
                pdfs.add(urljoin(base_url, m).split("#")[0])
            except Exception:
                pass
        # URLs inside onclick/JS handlers: window.open('...pdf'), location='...pdf'
        for m in re.findall(
            r'(?:window\.open|location\s*=|window\.location\.href\s*=)\s*\(\s*["\']([^"\'#]*\.pdf[^"\'#]*)',
            html, re.I,
        ):
            try:
                pdfs.add(urljoin(base_url, m).split("#")[0])
            except Exception:
                pass
        return pdfs

    @staticmethod
    def _extract_image_links(html: str, base_url: str) -> Set[str]:
        """Extract image URLs from HTML src attributes."""
        images: Set[str] = set()
        for m in re.findall(r'<img[^>]+src=["\']([^"\'#]+)', html, re.I):
            try:
                full = urljoin(base_url, m).split("#")[0].split("?")[0]
                # Only include common image extensions
                if any(full.lower().endswith(ext) for ext in
                       (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".tiff")):
                    images.add(full)
            except Exception:
                pass
        # Also check CSS background-image URLs
        for m in re.findall(r'url\(["\']?([^"\')\s]+\.(png|jpg|jpeg|gif|webp|svg))', html, re.I):
            try:
                images.add(urljoin(base_url, m[0]).split("#")[0].split("?")[0])
            except Exception:
                pass
        return images

    @staticmethod
    def _extract_doc_links(html: str, base_url: str) -> Set[str]:
        """Extract office document URLs (.doc, .docx, .pptx, .xlsx, etc.) from HTML."""
        docs: Set[str] = set()
        escaped = [re.escape(ext) for ext in DOC_EXTENSIONS]
        ext_pattern = "|".join(escaped)
        # Standard href and common data attributes
        pattern = (
            r'(?:href|src|data-href|data-url|data-src|data-download|data-file|action)'
            rf'=["\']([^"\'#]*(?:{ext_pattern})[^"\'#]*)'
        )
        for m in re.findall(pattern, html, re.I):
            try:
                docs.add(urljoin(base_url, m).split("#")[0])
            except Exception:
                pass
        # URLs inside onclick/JS handlers
        js_pattern = (
            r'(?:window\.open|location\s*=|window\.location\.href\s*=)\s*\(\s*["\']'
            rf'([^"\'#]*(?:{ext_pattern})[^"\'#]*)'
        )
        for m in re.findall(js_pattern, html, re.I):
            try:
                docs.add(urljoin(base_url, m).split("#")[0])
            except Exception:
                pass
        return docs

    @staticmethod
    def _price(text: str) -> Optional[str]:
        m = re.search(r"\$\s?\d{1,6}(?:\.\d{2})?", text)
        return m.group(0) if m else None

    def _classify_by_content_type(self, url: str, content_type: str) -> bool:
        """Check Content-Type and classify URL as PDF/doc. Returns True if classified."""
        if not content_type:
            return False
        ct_lower = content_type.lower().split(";")[0].strip()
        if ct_lower in PDF_CONTENT_TYPES:
            self.discovered_pdfs.add(url)
            return True
        if ct_lower in DOC_CONTENT_TYPES:
            self.discovered_docs.add(url)
            return True
        if ct_lower == "application/octet-stream":
            path_lower = urlparse(url).path.lower()
            if path_lower.endswith(".pdf"):
                self.discovered_pdfs.add(url)
                return True
            if any(path_lower.endswith(ext) for ext in DOC_EXTENSIONS):
                self.discovered_docs.add(url)
                return True
        return False

    async def _fetch_page(
        self,
        session: aiohttp.ClientSession,
        url: str,
        sem: asyncio.Semaphore,
    ) -> Optional[Dict]:
        """Fetch a single page with retry on 429/503."""
        # Use browser fetcher for JS-rendered sites
        # Note: browser_fetcher.fetch has its own semaphore, no double-lock
        if self.browser_fetcher:
            html, content_type = await self.browser_fetcher.fetch(url)
            # Content-Type detection: if URL serves a PDF/doc, classify it
            if self._classify_by_content_type(url, content_type):
                return None  # Not a page; it's a document
            if html:
                return {"url": url, "html": html, "status": 200}
            return None

        for attempt in range(3):
            async with sem:
                try:
                    async with session.get(
                        url,
                        timeout=aiohttp.ClientTimeout(total=30),
                        ssl=False,
                        allow_redirects=True,
                    ) as resp:
                        if resp.status == 200:
                            ct = resp.headers.get("content-type", "")
                            if "text/html" not in ct and "text/plain" not in ct:
                                # Content-Type detection: classify as PDF/doc if applicable
                                self._classify_by_content_type(url, ct)
                                return None
                            html = await resp.text()
                            return {"url": url, "html": html, "status": 200}
                        if resp.status in (429, 503) and attempt < 2:
                            await asyncio.sleep(2 ** (attempt + 1))
                            continue
                        return None
                except Exception:
                    if attempt < 2:
                        await asyncio.sleep(1)
                        continue
            break
        return None

    def _html_to_markdown(self, html: str) -> str:
        """Convert HTML to markdown, stripping boilerplate."""
        cleaned = self._strip_boilerplate(html)
        md = self._h2t.handle(cleaned)
        # Remove excessive blank lines
        md = re.sub(r"\n{4,}", "\n\n\n", md)
        return md.strip()

    def _save_md(self, url: str, title: str, md: str):
        """Save markdown + metadata to storage."""
        if not md or len(md.strip()) < 10:
            return
        # Guard against duplicate writes for the same URL
        if url in self.visited:
            return

        filename = self._fname(url) + ".md"
        parsed = urlparse(url)

        stored = self.storage.save_text(
            self.scope_name, "markdown", filename, md,
            content_type="text/markdown",
        )

        self.storage.record_artifact(ArtifactEntry(
            type="markdown", source_url=url, s3_key=stored,
            size_bytes=len(md.encode("utf-8")),
        ))

        lines = [l.strip() for l in md.split("\n")
                 if l.strip() and not l.strip().startswith("![")]
        summary = (lines[0][:200] + "...") if lines and len(lines[0]) > 200 else (lines[0] if lines else "")

        now = datetime.now(timezone.utc).isoformat()
        price = self._price(md)

        meta = {
            "source_url": url, "scope": self.scope_name,
            "content_type": "markdown", "document_id": self._id(url),
            "title": title, "domain": parsed.netloc, "path": parsed.path,
            "word_count": len(md.split()), "char_count": len(md),
            "crawled_at": now, "stored_path": stored,
        }
        if price:
            meta["price"] = price

        self.storage.save_text(
            self.scope_name, "metadata",
            f"{filename}.metadata.json",
            json.dumps(meta, indent=2),
            content_type="application/json",
        )

        self.results.append(CrawlResult(
            url=url, scope=self.scope_name, title=title,
            word_count=len(md.split()), char_count=len(md),
            content_type="markdown", file_path=stored,
            price=price, crawled_at=now, domain=parsed.netloc, summary=summary,
        ))

    async def run(self):
        """Scrape all URLs and save markdown."""
        total = len(self.urls)
        if not total:
            print("  [SCRAPER] No URLs to scrape")
            return

        print(f"  [SCRAPER] Scraping {total} pages (lightweight HTTP + html2text)")
        sem = asyncio.Semaphore(self.concurrency)
        succeeded = 0
        failed = 0

        async with aiohttp.ClientSession() as session:
            for i in range(0, total, 100):
                batch = self.urls[i:i + 100]
                # Stream results with as_completed() — each page uploads to S3 immediately
                tasks = [
                    asyncio.ensure_future(self._fetch_page(session, u, sem))
                    for u in batch
                ]
                completed_in_batch = 0
                for future in asyncio.as_completed(tasks):
                    try:
                        r = await future
                    except Exception:
                        failed += 1
                        completed_in_batch += 1
                        continue

                    if isinstance(r, dict) and r.get("html"):
                        url = r["url"]
                        html = r["html"]
                        title = self._extract_title(html)
                        if self.save_markdown:
                            md = self._html_to_markdown(html)
                            self._save_md(url, title, md)
                        self.visited.add(url)
                        succeeded += 1
                        # Extract PDF, doc, and image links from this page
                        page_pdfs = self._extract_pdf_links(html, url)
                        if page_pdfs:
                            self.discovered_pdfs.update(page_pdfs)
                        page_docs = self._extract_doc_links(html, url)
                        if page_docs:
                            self.discovered_docs.update(page_docs)
                        page_images = self._extract_image_links(html, url)
                        if page_images:
                            self.discovered_images.update(page_images)
                    else:
                        failed += 1
                    completed_in_batch += 1

                    # Update status every 10 pages (streaming, not batch-barrier)
                    if completed_in_batch % 10 == 0 and self.status_callback:
                        self.status_callback({
                            "pages_scraped": succeeded,
                            "pages_failed": failed,
                            "pages_total": total,
                            "markdown_uploaded": len(self.results),
                            "pdfs_found": len(self.discovered_pdfs),
                            "docs_found": len(self.discovered_docs),
                            "images_found": len(self.discovered_images),
                        })

                done = min(i + 100, total)
                action = "saved" if self.save_markdown else "scanned"
                print(
                    f"  [SCRAPER] {done}/{total} pages "
                    f"({succeeded} {action}, {failed} failed, "
                    f"{len(self.discovered_pdfs)} PDFs, "
                    f"{len(self.discovered_docs)} docs, "
                    f"{len(self.discovered_images)} images found)"
                )

                # Also update status after each chunk completes
                if self.status_callback:
                    self.status_callback({
                        "pages_scraped": succeeded,
                        "pages_failed": failed,
                        "pages_total": total,
                        "markdown_uploaded": len(self.results),
                        "pdfs_found": len(self.discovered_pdfs),
                        "docs_found": len(self.discovered_docs),
                        "images_found": len(self.discovered_images),
                    })

        action = "saved" if self.save_markdown else "scanned (no markdown)"
        print(f"  [SCRAPER] Complete: {succeeded} pages {action}, "
              f"{len(self.discovered_pdfs)} PDF links, "
              f"{len(self.discovered_docs)} doc links, "
              f"{len(self.discovered_images)} image links extracted")
