"""
Sitemap discovery: robots.txt -> sitemap_index.xml -> sub-sitemaps.

Handles:
  - WordPress wp-sitemap.xml with nested indexes
  - Namespace stripping for ElementTree compatibility
  - Filters out attachment-sitemap and author-sitemap (no useful content)
  - Caps total entries and sub-sitemap files to avoid runaway parsing
"""

import re
import xml.etree.ElementTree as ET
from typing import List, Set
from urllib.parse import urlparse

import aiohttp

from .config import SitemapEntry, MAX_SITEMAP_ENTRIES, MAX_SITEMAP_SUB_FILES


class SitemapDiscovery:

    COMMON_PATHS = [
        "/sitemap.xml", "/sitemap_index.xml", "/sitemap/sitemap.xml",
        "/sitemaps/sitemap.xml", "/wp-sitemap.xml",
        "/wp-sitemap-posts-post-1.xml", "/wp-sitemap-posts-page-1.xml",
        "/post-sitemap.xml", "/page-sitemap.xml", "/category-sitemap.xml",
    ]

    SKIP_SITEMAPS = [
        "attachment-sitemap", "author-sitemap", "wp-sitemap-users",
    ]

    def __init__(self, source_url: str):
        self.source_url = source_url
        self.entries: List[SitemapEntry] = []
        self._visited: Set[str] = set()
        self._sub_count = 0

        parsed = urlparse(source_url)
        path_parts = [p for p in parsed.path.strip("/").split("/") if p]
        self._relevance_kw = [p.lower() for p in path_parts[:3]]

    async def discover(self) -> List[SitemapEntry]:
        parsed = urlparse(self.source_url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        print(f"\n  [SITEMAP] Discovering sitemaps for {origin}")

        urls: Set[str] = set()
        for sm in await self._from_robots(f"{origin}/robots.txt"):
            urls.add(sm)
        for path in self.COMMON_PATHS:
            urls.add(f"{origin}{path}")

        for u in urls:
            if len(self.entries) >= MAX_SITEMAP_ENTRIES:
                break
            await self._parse(u)

        print(f"  [SITEMAP] Discovered {len(self.entries)} seed URLs")
        return self.entries

    async def _from_robots(self, url: str) -> List[str]:
        sitemaps = []
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(url, timeout=aiohttp.ClientTimeout(total=15)) as r:
                    if r.status == 200:
                        for line in (await r.text()).splitlines():
                            if line.strip().lower().startswith("sitemap:"):
                                sm = line.split(":", 1)[1].strip()
                                sitemaps.append(sm)
                                print(f"  [SITEMAP] robots.txt -> {sm}")
        except Exception:
            pass
        return sitemaps

    def _relevant(self, sub_url: str) -> bool:
        low = sub_url.lower()
        if any(skip in low for skip in self.SKIP_SITEMAPS):
            return False
        if not self._relevance_kw:
            return True
        return any(kw in low for kw in self._relevance_kw)

    async def _parse(self, url: str):
        if url in self._visited or len(self.entries) >= MAX_SITEMAP_ENTRIES:
            return
        self._visited.add(url)

        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(url, timeout=aiohttp.ClientTimeout(total=30)) as r:
                    if r.status != 200:
                        return
                    raw = await r.text()
        except Exception:
            return

        # Strip ALL namespace declarations AND prefixed attributes like xsi:*
        clean = re.sub(r'\s+xmlns(?::\w+)?="[^"]*"', "", raw)
        clean = re.sub(r'\s+xsi:\w+="[^"]*"', "", clean)

        try:
            root = ET.fromstring(clean)
        except ET.ParseError:
            return

        tag = root.tag.split("}")[-1] if "}" in root.tag else root.tag

        if tag == "sitemapindex":
            for elem in root.findall("./sitemap/loc"):
                if self._sub_count >= MAX_SITEMAP_SUB_FILES:
                    print(f"  [SITEMAP] Sub-sitemap cap reached ({MAX_SITEMAP_SUB_FILES})")
                    break
                if elem.text and self._relevant(elem.text.strip()):
                    self._sub_count += 1
                    print(f"  [SITEMAP] Sub-sitemap: {elem.text.strip()[:80]}")
                    await self._parse(elem.text.strip())
                elif elem.text:
                    # Even non-relevant, parse if we have room
                    if self._sub_count < MAX_SITEMAP_SUB_FILES and len(self.entries) < MAX_SITEMAP_ENTRIES:
                        self._sub_count += 1
                        await self._parse(elem.text.strip())

        elif tag == "urlset":
            for url_elem in root.findall("./url"):
                if len(self.entries) >= MAX_SITEMAP_ENTRIES:
                    break
                loc = url_elem.find("loc")
                if loc is None or not loc.text:
                    continue
                lm = url_elem.find("lastmod")
                pr = url_elem.find("priority")
                self.entries.append(SitemapEntry(
                    url=loc.text.strip(),
                    lastmod=lm.text.strip() if lm is not None and lm.text else None,
                    priority=float(pr.text.strip()) if pr is not None and pr.text else None,
                ))
