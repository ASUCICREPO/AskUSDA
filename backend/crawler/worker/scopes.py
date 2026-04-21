"""
Scope regex builders for URL filtering.

Supported scopes:
  - path     (default) : same host + same path prefix
  - host               : same host, any path
  - subdomains         : all *.domain.tld including domain.tld itself
"""

import re
from urllib.parse import urlparse


def build_scope_regex(source_url: str, scope_name: str) -> re.Pattern:
    parsed = urlparse(source_url)
    host = re.escape(parsed.netloc)

    if scope_name == "path":
        base = parsed.path.rstrip("/")
        if base:
            return re.compile(rf"^https?://{host}{re.escape(base)}([/?#].*)?$")
        return re.compile(rf"^https?://{host}([/?#].*)?$")

    if scope_name == "host":
        return re.compile(rf"^https?://{host}([/?#].*)?$")

    if scope_name == "subdomains":
        parts = parsed.netloc.split(".")
        if len(parts) >= 2:
            primary = re.escape(".".join(parts[-2:]))
            return re.compile(rf"^https?://([a-zA-Z0-9\-]+\.)*{primary}([/?#].*)?$")
        return re.compile(rf"^https?://{host}([/?#].*)?$")

    return re.compile(".*")


ALL_SCOPES = ["path", "host", "subdomains"]


def resolve_scopes(scope_type: str) -> list[str]:
    """Return the list of scope names to run based on SCOPE_TYPE."""
    if scope_type == "all":
        return ALL_SCOPES
    if scope_type in ALL_SCOPES:
        return [scope_type]
    return ALL_SCOPES
