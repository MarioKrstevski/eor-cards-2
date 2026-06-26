"""Aligns a document heading outline against a curriculum subtree.

Pure functions — no DB session. The caller loads Curriculum rows and passes them
as plain dicts so this module is trivially unit-testable.
"""
from __future__ import annotations
import re

_WEIGHT_SUFFIX = re.compile(r"\s*[–-]\s*\d+\s*%\s*$")  # " – 18%" / " - 10%"


def normalize_topic(s: str) -> str:
    """Normalize a topic/heading name for matching: drop a trailing exam-weight
    suffix, lowercase, collapse whitespace, tighten slashes."""
    s = _WEIGHT_SUFFIX.sub("", s or "")
    s = s.lower().strip()
    s = re.sub(r"\s*/\s*", "/", s)
    s = re.sub(r"\s+", " ", s)
    return s
