"""
Lightweight document discovery phase.

Scans all sitemap URLs (plus the seed URL) with simple aiohttp HTTP requests
(no headless browser) to extract PDF and office document links from HTML.
This is Phase 1.5 — runs after sitemap discovery but before scraping,
ensuring ALL document URLs are found.

General-purpose detection (works for ANY website):
  1. File extension: .pdf, known doc extensions (.docx, .xlsx, etc.)
  2. Content-Type probing: HEAD requests on ambiguous links (no file extension)
     to check actual Content-Type headers from the server. This catches PDFs/docs
     served by any CMS, file server, or API without hardcoding URL patterns.

Scope-aware: uses the same scope regex logic as the page crawl so that
subdomain documents are captured when scope_type includes "subdomains".
"""

import asyncio
import re
from typing import Dict, List, Optional, Set
from urllib.parse import urlparse, urljoin

import aiohttp

from .config import (
    PDF_DISCOVERY_CONCURRENCY, DOC_EXTENSIONS,
    PDF_CONTENT_TYPES, DOC_CONTENT_TYPES, SKIP_EXT,
)
from .scopes import build_scope_regex


# Extensions that are already classified — no HEAD request needed
_KNOWN_PDF_EXT = {".pdf"}
_KNOWN_DOC_EXT = set(DOC_EXTENSIONS)
_KNOWN_SKIP_EXT = SKIP_EXT | {".html", ".htm", ".php", ".asp", ".aspx", ".jsp", ".shtml"}
_ALL_KNOWN_EXT = _KNOWN_PDF_EXT | _KNOWN_DOC_EXT | _KNOWN_SKIP_EXT


class PDFDiscovery:
    """Discovers PDF and office document URLs by scanning pages with lightweight HTTP requests."""

    def __init__(
        self,
        source_url: str,
        sitemap_urls: List[str],
        scope_type: str = "all",
        concurrency: int = 0,
        file_types: Set[str] = None,  # {"pdf"} and/or {"doc"} — which types to look for
        browser_fetcher=None,
    ):
        self.source_url = source_url
        self.sitemap_urls = sitemap_urls
        self.scope_type = scope_type
        self.concurrency = concurrency or PDF_DISCOVERY_CONCURRENCY
        self.file_types = file_types or {"pdf"}
        self.browser_fetcher = browser_fetcher

        # Build scope filter — use the broadest scope requested.
        broadest = "subdomains" if scope_type == "all" else scope_type
        self._scope_filter = build_scope_regex(source_url, broadest)
        self._source_domain = urlparse(source_url).netloc.lower()

        # Build doc extensions regex pattern
        escaped = [re.escape(ext) for ext in DOC_EXTENSIONS]
        self._doc_ext_pattern = "|".join(escaped)

    @staticmethod
    def _extract_all_links(html: str, base_url: str) -> Set[str]:
        """Extract ALL href links from HTML (for Content-Type probing)."""
        links: Set[str] = set()
        for m in re.findall(r'href=["\']([^"\'#]+)', html, re.I):
            try:
                full = urljoin(base_url, m).split("#")[0]
                if full.startswith("http"):
                    links.add(full)
            except Exception:
                pass
        return links

    @staticmethod
    def _extract_pdf_links(html: str, base_url: str) -> Set[str]:
        """Extract PDF URLs from HTML by file extension (.pdf).

        Links without .pdf extension are handled by Content-Type probing
        via _extract_all_links + _needs_content_type_probe + _probe_content_type.
        """
        pdfs: Set[str] = set()

        # Standard href links ending in .pdf
        for m in re.findall(r'href=["\']([^"\'#]*\.pdf[^"\'#]*)', html, re.I):
            try:
                full = urljoin(base_url, m).split("#")[0]
                pdfs.add(full)
            except Exception:
                pass

        # PDF links in src, data-href, data-url attributes
        for m in re.findall(
            r'(?:src|data-href|data-url)=["\']([^"\'#]*\.pdf[^"\'#]*)',
            html,
            re.I,
        ):
            try:
                pdfs.add(urljoin(base_url, m).split("#")[0])
            except Exception:
                pass

        return pdfs

    def _extract_doc_links(self, html: str, base_url: str) -> Set[str]:
        """Extract office document URLs (.doc, .docx, .pptx, .xlsx, etc.) from HTML."""
        docs: Set[str] = set()
        pattern = rf'href=["\']([^"\'#]*(?:{self._doc_ext_pattern})[^"\'#]*)'
        for m in re.findall(pattern, html, re.I):
            try:
                full = urljoin(base_url, m).split("#")[0]
                docs.add(full)
            except Exception:
                pass
        pattern2 = rf'(?:src|data-href|data-url)=["\']([^"\'#]*(?:{self._doc_ext_pattern})[^"\'#]*)'
        for m in re.findall(pattern2, html, re.I):
            try:
                docs.add(urljoin(base_url, m).split("#")[0])
            except Exception:
                pass
        return docs

    @staticmethod
    def _needs_content_type_probe(url: str) -> bool:
        """Check if a link has an ambiguous extension that needs HEAD-request probing.

        Returns True for URLs without a recognized file extension — these could
        serve PDFs/docs despite having no extension (e.g. /documents/view/16052).
        """
        path = urlparse(url).path.lower().rstrip("/")
        if not path or path == "/":
            return False
        # Get the last path segment's extension
        last_segment = path.split("/")[-1]
        if "." in last_segment:
            ext = "." + last_segment.rsplit(".", 1)[-1]
            if ext in _ALL_KNOWN_EXT:
                return False  # Already classified by extension
        # No extension or unrecognized extension — probe it
        return True

    async def _probe_content_type(
        self,
        session: aiohttp.ClientSession,
        url: str,
        sem: asyncio.Semaphore,
    ) -> Optional[Dict[str, str]]:
        """Check Content-Type via browser or HTTP HEAD. Returns {"url": url, "type": "pdf"|"doc"} or None.

        When browser_fetcher is available (WAF-protected sites), uses browser fetch()
        to bypass blocks. Falls back to aiohttp HEAD for normal HTTP sites.
        """
        # Use browser probing for WAF-protected sites (Akamai, Cloudflare, etc.)
        if self.browser_fetcher:
            try:
                ct = await self.browser_fetcher.probe_content_type(url)
                if ct:
                    ct_lower = ct.lower().split(";")[0].strip()
                    if ct_lower in PDF_CONTENT_TYPES:
                        return {"url": url, "type": "pdf"}
                    if ct_lower in DOC_CONTENT_TYPES:
                        return {"url": url, "type": "doc"}
            except Exception:
                pass
            return None  # Browser probe failed; don't fallback to aiohttp (would also be blocked)

        # Fallback: aiohttp HEAD for sites without WAF
        async with sem:
            try:
                async with session.head(
                    url,
                    timeout=aiohttp.ClientTimeout(total=10),
                    ssl=False,
                    allow_redirects=True,
                ) as resp:
                    if resp.status == 200:
                        ct = resp.headers.get("content-type", "").lower().split(";")[0].strip()
                        if ct in PDF_CONTENT_TYPES:
                            return {"url": url, "type": "pdf"}
                        if ct in DOC_CONTENT_TYPES:
                            return {"url": url, "type": "doc"}
                    # Some servers don't support HEAD — try GET with minimal read
                    elif resp.status == 405:
                        return await self._probe_content_type_get(session, url)
            except Exception:
                pass
        return None

    async def _probe_content_type_get(
        self,
        session: aiohttp.ClientSession,
        url: str,
    ) -> Optional[Dict[str, str]]:
        """Fallback: GET with range header to check Content-Type without downloading."""
        try:
            async with session.get(
                url,
                timeout=aiohttp.ClientTimeout(total=10),
                ssl=False,
                allow_redirects=True,
                headers={"Range": "bytes=0-0"},
            ) as resp:
                if resp.status in (200, 206):
                    ct = resp.headers.get("content-type", "").lower().split(";")[0].strip()
                    if ct in PDF_CONTENT_TYPES:
                        return {"url": url, "type": "pdf"}
                    if ct in DOC_CONTENT_TYPES:
                        return {"url": url, "type": "doc"}
        except Exception:
            pass
        return None

    async def _scan_page(
        self,
        session: aiohttp.ClientSession,
        url: str,
        sem: asyncio.Semaphore,
    ) -> Dict[str, Set[str]]:
        """Fetch a single page and extract document links, with retry on 429/503."""
        # Use browser fetcher for JS-rendered sites
        # Note: browser_fetcher.fetch has its own semaphore, no double-lock
        if self.browser_fetcher:
            html, content_type = await self.browser_fetcher.fetch(url)
            if html:
                result: Dict[str, Set[str]] = {}
                if "pdf" in self.file_types:
                    result["pdf"] = self._extract_pdf_links(html, url)
                if "doc" in self.file_types:
                    result["doc"] = self._extract_doc_links(html, url)
                # Collect ambiguous links for Content-Type probing
                result["_probe"] = self._extract_all_links(html, url)
                return result
            return {}

        for attempt in range(3):
            async with sem:
                try:
                    async with session.get(
                        url,
                        timeout=aiohttp.ClientTimeout(total=20),
                        ssl=False,
                    ) as resp:
                        if resp.status == 200:
                            html = await resp.text()
                            result: Dict[str, Set[str]] = {}
                            if "pdf" in self.file_types:
                                result["pdf"] = self._extract_pdf_links(html, url)
                            if "doc" in self.file_types:
                                result["doc"] = self._extract_doc_links(html, url)
                            # Collect ambiguous links for Content-Type probing
                            result["_probe"] = self._extract_all_links(html, url)
                            return result
                        if resp.status in (429, 503) and attempt < 2:
                            await asyncio.sleep(2 ** (attempt + 1))
                            continue
                except Exception:
                    if attempt < 2:
                        await asyncio.sleep(1)
                        continue
            break
        return {}

    def _is_in_scope(self, url: str) -> bool:
        """Check if a PDF URL matches the configured scope (domain/subdomain aware)."""
        return bool(self._scope_filter.match(url))

    async def discover(self) -> Dict[str, Set[str]]:
        """Scan all sitemap URLs (+ seed) and return discovered document URLs in scope.

        Returns: {"pdf": set(...), "doc": set(...)} depending on file_types requested.
        """
        # Always include the seed URL even if sitemap is empty or doesn't list it
        urls = list(dict.fromkeys([self.source_url] + list(self.sitemap_urls)))
        if not urls:
            return {ft: set() for ft in self.file_types}

        types_label = " + ".join(sorted(self.file_types)).upper()
        print(f"  [DOC DISCOVERY] Scanning {len(urls)} pages for {types_label} links...")
        print(f"  [DOC DISCOVERY] Scope filter: {self._scope_filter.pattern}")
        sem = asyncio.Semaphore(self.concurrency)
        all_found: Dict[str, Set[str]] = {ft: set() for ft in self.file_types}
        succeeded_urls: Set[str] = set()
        ambiguous_links: Set[str] = set()  # Links needing Content-Type probing

        async with aiohttp.ClientSession() as session:
            for i in range(0, len(urls), 100):
                batch = urls[i : i + 100]
                results = await asyncio.gather(
                    *(self._scan_page(session, u, sem) for u in batch),
                    return_exceptions=True,
                )
                for url, r in zip(batch, results):
                    if isinstance(r, dict):
                        for ft, found_urls in r.items():
                            if ft == "_probe":
                                ambiguous_links.update(found_urls)
                                continue
                            if found_urls:
                                all_found[ft].update(found_urls)
                        succeeded_urls.add(url)
                counts = ", ".join(f"{len(all_found[ft])} {ft.upper()}s" for ft in sorted(all_found))
                print(
                    f"  [DOC DISCOVERY] Scanned {min(i + 100, len(urls))}/{len(urls)} "
                    f"pages... ({counts} so far)"
                )

            # Retry failed URLs with lower concurrency
            failed = [u for u in urls if u not in succeeded_urls]
            if failed:
                print(f"  [DOC DISCOVERY] Retrying {len(failed)} failed pages...")
                retry_sem = asyncio.Semaphore(10)
                for i in range(0, len(failed), 50):
                    batch = failed[i : i + 50]
                    results = await asyncio.gather(
                        *(self._scan_page(session, u, retry_sem) for u in batch),
                        return_exceptions=True,
                    )
                    for r in results:
                        if isinstance(r, dict):
                            for ft, found_urls in r.items():
                                if ft == "_probe":
                                    ambiguous_links.update(found_urls)
                                    continue
                                if found_urls:
                                    all_found[ft].update(found_urls)

            # --- Content-Type probing: the general-purpose detection ---
            # For links without recognized extensions, send HEAD requests to
            # check if they serve PDFs/docs. This catches ALL CMS platforms.
            already_found = set()
            for ft in all_found:
                already_found.update(all_found[ft])

            # Filter: only probe in-scope links with ambiguous extensions
            to_probe = {
                u for u in ambiguous_links
                if u not in already_found
                and self._is_in_scope(u)
                and self._needs_content_type_probe(u)
            }

            if to_probe:
                print(f"  [DOC DISCOVERY] Probing {len(to_probe)} ambiguous links via HEAD requests...")
                probe_sem = asyncio.Semaphore(min(30, self.concurrency))
                probed_pdfs = 0
                probed_docs = 0
                for i in range(0, len(to_probe), 200):
                    batch = list(to_probe)[i:i + 200]
                    results = await asyncio.gather(
                        *(self._probe_content_type(session, u, probe_sem) for u in batch),
                        return_exceptions=True,
                    )
                    for r in results:
                        if isinstance(r, dict):
                            if r["type"] == "pdf" and "pdf" in self.file_types:
                                all_found["pdf"].add(r["url"])
                                probed_pdfs += 1
                            elif r["type"] == "doc" and "doc" in self.file_types:
                                all_found["doc"].add(r["url"])
                                probed_docs += 1
                print(
                    f"  [DOC DISCOVERY] Content-Type probing found "
                    f"{probed_pdfs} PDFs + {probed_docs} docs from {len(to_probe)} checked"
                )

        # Filter using scope regex instead of exact domain match
        result: Dict[str, Set[str]] = {}
        for ft in self.file_types:
            in_scope = {u for u in all_found[ft] if self._is_in_scope(u)}
            out_of_scope = len(all_found[ft]) - len(in_scope)
            print(f"  [DOC DISCOVERY] {ft.upper()}: {len(in_scope)} in scope ({self.scope_type})")
            if out_of_scope:
                print(f"  [DOC DISCOVERY] {ft.upper()}: Skipped {out_of_scope} out-of-scope")
            result[ft] = in_scope

        return result
