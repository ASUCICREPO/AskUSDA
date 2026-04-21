"""
Browser-based page fetcher using crawl4ai.

Provides JavaScript rendering for SPA sites that return empty HTML
with plain HTTP requests. Uses crawl4ai's built-in features:

  - arun_many() with MemoryAdaptiveDispatcher — auto-throttles when RAM > 90%
  - text_mode for BFS — disables images for faster page loads
  - domcontentloaded for BFS — faster than networkidle (nav links load early)
  - networkidle for scraping — waits for full content rendering
  - Built-in link extraction — captures JS-generated navigation
  - HTML cache — pages rendered once in BFS reused in phase 2 (0s instead of 8s)
  - Streaming results — process pages as they complete
"""

import asyncio
from typing import Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse

from .config import BROWSER_CONCURRENCY


class BrowserFetcher:
    """Manages a shared headless browser for JS-rendered page fetching."""

    def __init__(self, concurrency: int = BROWSER_CONCURRENCY):
        self._concurrency = concurrency
        self._sem = asyncio.Semaphore(concurrency)
        self._crawler = None
        self._bfs_config = None
        self._scrape_config = None
        # Cache: URL → rendered HTML. Populated during BFS, reused in phases 1.5/2.
        self._html_cache: Dict[str, str] = {}
        # Persistent Playwright context for binary downloads (PDFs/docs).
        # Created lazily, warmed up once per domain to pass WAF challenges.
        self._dl_playwright = None
        self._dl_browser = None
        self._dl_context = None
        self._dl_warmed_domains: Set[str] = set()
        self._c4ai_ctx_logged = False

    @property
    def cache_size(self) -> int:
        return len(self._html_cache)

    async def start(self):
        """Launch the headless browser via crawl4ai with optimized settings."""
        from crawl4ai import AsyncWebCrawler, CrawlerRunConfig

        # BrowserConfig: text_mode disables images for faster BFS
        try:
            from crawl4ai import BrowserConfig
            browser_config = BrowserConfig(
                headless=True,
                verbose=False,
                text_mode=False,      # Keep images for scraping (toggled per-config)
                light_mode=True,      # Disable background features for perf
            )
            self._crawler = AsyncWebCrawler(config=browser_config)
        except (ImportError, TypeError):
            self._crawler = AsyncWebCrawler(headless=True, verbose=False)

        await self._crawler.__aenter__()

        # BFS config: fast link discovery — domcontentloaded + minimal delay
        # Nav links are in sidebar/header from initial DOM, no need for networkidle
        self._bfs_config = CrawlerRunConfig(
            wait_until="domcontentloaded",
            page_timeout=30000,
            delay_before_return_html=0.1,
            scan_full_page=False,
            cache_mode=None,
        )

        # Scrape config: full content — networkidle + scroll for lazy content
        self._scrape_config = CrawlerRunConfig(
            wait_until="networkidle",
            page_timeout=30000,
            delay_before_return_html=1.5,
            scan_full_page=True,
            cache_mode=None,
        )

        print(f"  [BROWSER] Headless browser launched "
              f"(domcontentloaded BFS + networkidle scrape, "
              f"max {self._concurrency} concurrent tabs)")

    def _normalize_key(self, url: str) -> str:
        """Normalize URL for cache lookup."""
        return url.lower().rstrip("/")

    # ----------------------------------------------------------------
    # Single-page fetch (used by lightweight_scraper for cache misses)
    # ----------------------------------------------------------------

    async def fetch(self, url: str) -> Tuple[Optional[str], str]:
        """Fetch a URL with JS rendering. Returns (html, content_type).

        content_type is extracted from response headers to detect PDFs/docs
        served without file extensions (works for any CMS/server).
        """
        if not self._crawler:
            return (None, "")

        key = self._normalize_key(url)
        if key in self._html_cache:
            return (self._html_cache[key], "text/html")  # Cached pages are HTML

        async with self._sem:
            try:
                result = await self._crawler.arun(
                    url=url,
                    config=self._scrape_config or None,
                )
                html = result.html if result and result.html else None
                content_type = ""

                # Extract Content-Type from response headers
                if result and hasattr(result, "response_headers") and result.response_headers:
                    headers = result.response_headers
                    if isinstance(headers, dict):
                        content_type = headers.get("content-type", headers.get("Content-Type", ""))

                if html:
                    self._html_cache[key] = html
                    return (html, content_type)
                return (None, content_type)
            except Exception as e:
                print(f"  [BROWSER] Error {url[:60]}: {e}")
                return (None, "")

    async def fetch_with_links(self, url: str) -> Tuple[Optional[str], Set[str], str]:
        """Fetch a URL and return (html, links, content_type). Uses fast BFS config.

        content_type is extracted from crawl4ai's response_headers so callers
        can detect PDFs/docs served without file extensions (general-purpose).
        """
        if not self._crawler:
            return (None, set(), "")

        async with self._sem:
            try:
                result = await self._crawler.arun(
                    url=url,
                    config=self._bfs_config or None,
                )
                html = result.html if result and result.html else None
                links: Set[str] = set()
                content_type = ""

                # Extract Content-Type from response headers (crawl4ai provides this)
                if result and hasattr(result, "response_headers") and result.response_headers:
                    headers = result.response_headers
                    if isinstance(headers, dict):
                        content_type = headers.get("content-type", headers.get("Content-Type", ""))

                if html:
                    self._html_cache[self._normalize_key(url)] = html

                if result and hasattr(result, "links") and result.links:
                    for link_type in ("internal", "external"):
                        for link_info in result.links.get(link_type, []):
                            href = ""
                            if isinstance(link_info, dict):
                                href = link_info.get("href", "")
                            elif isinstance(link_info, str):
                                href = link_info
                            if href and href.startswith("http"):
                                links.add(href.split("#")[0])

                if links:
                    print(f"  [BROWSER] {url[:60]} → {len(links)} links extracted")

                return (html, links, content_type)
            except Exception as e:
                print(f"  [BROWSER] Error {url[:60]}: {e}")
                return (None, set(), "")

    # ----------------------------------------------------------------
    # Batch fetch via arun_many() — uses MemoryAdaptiveDispatcher
    # Auto-throttles when RAM > 90%, prevents OOM kills
    # ----------------------------------------------------------------

    async def fetch_many(self, urls: List[str], use_bfs_config: bool = False) -> List:
        """Batch-fetch URLs using crawl4ai's arun_many with memory-adaptive concurrency.

        Returns list of CrawlResult objects. Automatically manages memory
        pressure — throttles concurrency when RAM usage exceeds 90%.
        """
        if not self._crawler or not urls:
            return []

        from crawl4ai import CrawlerRunConfig

        config = self._bfs_config if use_bfs_config else self._scrape_config

        # Use MemoryAdaptiveDispatcher (crawl4ai default) for auto memory management
        try:
            from crawl4ai.async_dispatcher import MemoryAdaptiveDispatcher, RateLimiter
            dispatcher = MemoryAdaptiveDispatcher(
                memory_threshold_percent=85.0,
                critical_threshold_percent=92.0,
                max_session_permit=self._concurrency,
                rate_limiter=RateLimiter(
                    base_delay=(0.1, 0.5),
                    max_delay=30.0,
                    max_retries=2,
                ),
            )
        except ImportError:
            dispatcher = None

        try:
            kwargs = {"urls": urls, "config": config}
            if dispatcher:
                kwargs["dispatcher"] = dispatcher
            results = await self._crawler.arun_many(**kwargs)

            # Cache HTML from results
            out = []
            for r in results:
                if r and r.html:
                    self._html_cache[self._normalize_key(r.url)] = r.html
                out.append(r)

            return out
        except Exception as e:
            print(f"  [BROWSER] arun_many error: {e}")
            return []

    # ----------------------------------------------------------------
    # Binary download (PDFs/docs) — uses the browser session with its
    # cookies, TLS fingerprint, and WAF tokens. General-purpose fallback
    # when plain HTTP clients get 403 from protected servers.
    # ----------------------------------------------------------------

    def _get_crawl4ai_context(self):
        """Get crawl4ai's internal Playwright browser context.

        Path: crawler_strategy.browser_manager has:
          - .browser — Playwright Browser object with .contexts list
          - .contexts_by_config — dict of context wrappers

        We use browser.contexts to get real Playwright BrowserContext objects
        that have the WAF cookies from BFS page visits.
        """
        if not self._crawler:
            return None

        try:
            bm = getattr(
                getattr(self._crawler, "crawler_strategy", None),
                "browser_manager", None,
            )
            if not bm:
                return None

            # Get the Playwright Browser object and its active contexts
            browser = getattr(bm, "browser", None)
            if browser and hasattr(browser, "contexts"):
                ctxs = browser.contexts
                if ctxs:
                    if not self._c4ai_ctx_logged:
                        print(f"  [BROWSER DL] Using crawl4ai browser context ({len(ctxs)} contexts available)")
                        self._c4ai_ctx_logged = True
                    return ctxs[0]  # First context has WAF cookies from BFS

        except Exception as e:
            print(f"  [BROWSER DL] Error accessing crawl4ai context: {e}")

        return None

    async def _ensure_download_context(self, url: str):
        """Create and warm up a persistent Playwright context for downloads.

        General-purpose: visits the domain root to pass WAF challenges (Akamai,
        Cloudflare, etc.) and pick up session cookies. The context is reused for
        all subsequent downloads from the same domain, avoiding per-download
        browser launches.
        """
        if not self._dl_context:
            from playwright.async_api import async_playwright
            self._dl_playwright = await async_playwright().start()
            self._dl_browser = await self._dl_playwright.chromium.launch(headless=True)
            self._dl_context = await self._dl_browser.new_context()

        # Warm up for this domain if not already done
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        if domain not in self._dl_warmed_domains:
            root_url = f"{parsed.scheme}://{domain}/"
            page = await self._dl_context.new_page()
            try:
                await page.goto(root_url, wait_until="networkidle", timeout=30000)
                # Wait for WAF JS challenges (Akamai _abck, Cloudflare cf_clearance, etc.)
                await page.wait_for_timeout(5000)
                self._dl_warmed_domains.add(domain)
                print(f"  [BROWSER DL] Warmed up download context for {domain}")
            except Exception as e:
                print(f"  [BROWSER DL] Warmup warning for {domain}: {e}")
                self._dl_warmed_domains.add(domain)  # Don't retry
            finally:
                await page.close()

        return self._dl_context

    async def probe_content_type(self, url: str) -> Optional[str]:
        """Probe Content-Type header via browser fetch() WITHOUT downloading full body.

        Uses JavaScript fetch() in browser to check response headers only.
        This bypasses WAF blocks (Akamai, Cloudflare) that prevent aiohttp HEAD requests.
        Returns Content-Type string or None if probe fails.
        """
        async with self._sem:
            try:
                # Try crawl4ai's context first (already has WAF cookies)
                c4ai_ctx = self._get_crawl4ai_context()
                if c4ai_ctx:
                    ct = await self._probe_via_context(c4ai_ctx, url)
                    if ct:
                        return ct

                # Fallback: persistent download context with WAF warmup
                context = await self._ensure_download_context(url)
                return await self._probe_via_context(context, url)
            except Exception:
                pass
        return None

    async def _probe_via_context(self, context, url: str) -> Optional[str]:
        """Send HEAD-like probe via browser fetch() to get Content-Type header only."""
        from urllib.parse import urlparse
        parsed = urlparse(url)
        root_url = f"{parsed.scheme}://{parsed.netloc}/"
        try:
            page = await context.new_page()
        except Exception:
            return None
        try:
            # Navigate to domain root (needed for same-origin fetch)
            try:
                await page.goto(root_url, wait_until="domcontentloaded", timeout=10000)
            except Exception:
                pass

            # Use fetch() to read only headers (method: 'HEAD' or just check headers)
            result = await page.evaluate("""
                async (url) => {
                    try {
                        const response = await fetch(url, { method: 'HEAD' });
                        if (!response.ok) return null;
                        return response.headers.get('content-type') || null;
                    } catch (e) {
                        // Some servers don't support HEAD, try GET but don't read body
                        try {
                            const response = await fetch(url);
                            if (!response.ok) return null;
                            return response.headers.get('content-type') || null;
                        } catch (e2) {
                            return null;
                        }
                    }
                }
            """, url)
            return result if isinstance(result, str) else None
        except Exception:
            pass
        finally:
            try:
                await page.close()
            except Exception:
                pass
        return None

    async def download_bytes(self, url: str) -> Optional[Tuple[bytes, str]]:
        """Download binary content (PDF/doc) via a browser with WAF cookies.

        First tries crawl4ai's browser context (which already passed WAF on the site).
        Falls back to a persistent Playwright context warmed up per-domain.
        """
        async with self._sem:
            try:
                # First try: use crawl4ai's context (already has WAF cookies)
                c4ai_ctx = self._get_crawl4ai_context()
                if c4ai_ctx:
                    result = await self._download_via_context(c4ai_ctx, url)
                    if result:
                        return result

                # Fallback: persistent download context with WAF warmup
                context = await self._ensure_download_context(url)
                return await self._download_via_context(context, url)
            except Exception as e:
                print(f"  [BROWSER DL] Error {url[:60]}: {e}")
        return None

    async def _download_via_context(self, context, url: str) -> Optional[Tuple[bytes, str]]:
        """Download binary content using a Playwright browser context.

        Uses JavaScript fetch() inside the browser page to get raw bytes.
        This uses the browser's cookies AND network stack (same TLS fingerprint),
        returning actual binary content instead of Chrome's PDF viewer wrapper.
        """
        import base64
        parsed = urlparse(url)
        # Navigate to domain root first so fetch() has the right origin
        root_url = f"{parsed.scheme}://{parsed.netloc}/"
        try:
            page = await context.new_page()
        except Exception as e:
            print(f"  [BROWSER DL] new_page error: {e}")
            return None
        try:
            # Navigate to domain root (needed for same-origin fetch)
            try:
                await page.goto(root_url, wait_until="domcontentloaded", timeout=15000)
            except Exception:
                pass

            # Use fetch() in browser JS to get raw bytes (avoids PDF viewer wrapper)
            result = await page.evaluate("""
                async (url) => {
                    try {
                        const response = await fetch(url);
                        if (!response.ok) return { error: response.status };
                        const ct = response.headers.get('content-type') || '';
                        const blob = await response.blob();
                        return await new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve({
                                data: reader.result.split(',')[1],
                                ct: ct,
                                size: blob.size,
                            });
                            reader.readAsDataURL(blob);
                        });
                    } catch (e) {
                        return { error: e.message };
                    }
                }
            """, url)

            if isinstance(result, dict):
                if "error" in result:
                    print(f"  [BROWSER DL] HTTP {result['error']} {url[:60]}")
                    return None
                if result.get("data") and result.get("size", 0) > 100:
                    body = base64.b64decode(result["data"])
                    return (body, result.get("ct", ""))
        except Exception as e:
            print(f"  [BROWSER DL] Error {url[:60]}: {e}")
        finally:
            try:
                await page.close()
            except Exception:
                pass
        return None

    # ----------------------------------------------------------------
    # Cache management
    # ----------------------------------------------------------------

    def clear_cache(self):
        """Free cached HTML memory."""
        count = len(self._html_cache)
        self._html_cache.clear()
        if count:
            print(f"  [BROWSER] Cache cleared ({count} pages)")

    async def close(self):
        """Shutdown the browser and free cache."""
        self._html_cache.clear()
        # Clean up persistent download context
        if self._dl_context:
            try:
                await self._dl_context.close()
            except Exception:
                pass
            self._dl_context = None
        if self._dl_browser:
            try:
                await self._dl_browser.close()
            except Exception:
                pass
            self._dl_browser = None
        if self._dl_playwright:
            try:
                await self._dl_playwright.stop()
            except Exception:
                pass
            self._dl_playwright = None
        self._dl_warmed_domains.clear()
        # Clean up crawl4ai browser
        if self._crawler:
            try:
                await self._crawler.__aexit__(None, None, None)
            except Exception:
                pass
            self._crawler = None
            print(f"  [BROWSER] Browser closed")
