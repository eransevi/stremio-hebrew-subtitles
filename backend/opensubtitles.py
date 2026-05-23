import logging
import re
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger("argos_subtitles.opensubtitles")

FILENAME_REMOVE_EXT = re.compile(r"\.json$|\.[^.]+$", re.IGNORECASE)


def filename_to_query(filename: str) -> str:
    return FILENAME_REMOVE_EXT.sub("", filename)


def build_filename_queries(filename: str) -> List[str]:
    base = filename_to_query(filename)
    normalized_separators = re.sub(r"[._,-]+", " ", base).strip()
    normalized_hyphens = re.sub(r"[-]+", " ", base).strip()

    candidates = [base]
    if normalized_separators and normalized_separators != base:
        candidates.append(normalized_separators)
    if normalized_hyphens and normalized_hyphens != base and normalized_hyphens != normalized_separators:
        candidates.append(normalized_hyphens)

    return list(dict.fromkeys(candidates))


def search_subtitles(imdb_id: str, filename: Optional[str], api_key: str) -> List[Dict[str, Any]]:
    if not api_key:
        raise RuntimeError("OpenSubtitles API key is not configured")

    queries = build_filename_queries(filename) if filename else [""]
    logger.info("Searching OpenSubtitles", {"imdb_id": imdb_id, "queries": queries})

    headers = {
        "Api-Key": api_key,
        "User-Agent": "Stremio Hebrew Subtitles/1.0",
        "Accept": "application/json"
    }

    def parse_response(res: httpx.Response) -> List[Dict[str, Any]]:
        try:
            data = res.json()
        except Exception as exc:
            logger.error("Failed to parse OpenSubtitles response", exc_info=exc)
            raise RuntimeError("Invalid OpenSubtitles response")

        if not res.is_success:
            logger.error("OpenSubtitles API error", {"status": res.status_code, "body": data})
            raise RuntimeError("OpenSubtitles API request failed")

        return data.get("data") or []

    for query in queries:
        params = {"imdb_id": imdb_id, "languages": "en"}
        if query:
            params["query"] = query

        response = httpx.get("https://api.opensubtitles.com/api/v1/subtitles", params=params, headers=headers, timeout=30.0)
        logger.info("OpenSubtitles search response", {"imdb_id": imdb_id, "query": query, "status": response.status_code})
        items = parse_response(response)
        if items:
            logger.info("OpenSubtitles found candidates", {"imdb_id": imdb_id, "query": query, "count": len(items)})
            return items

    logger.info("OpenSubtitles returned no results", {"imdb_id": imdb_id, "queries": queries})
    return []


def rank_subtitles(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not items:
        raise RuntimeError("No subtitles found")

    ranked = sorted(items, key=lambda item: item.get("attributes", {}).get("download_count", 0), reverse=True)
    best = ranked[0]
    logger.info("Selected best subtitle candidate", {
        "id": best.get("id"),
        "release": best.get("attributes", {}).get("release"),
        "download_count": best.get("attributes", {}).get("download_count", 0)
    })
    return best


def resolve_subtitle_download_url(item: Dict[str, Any], api_key: str) -> str:
    if not api_key:
        raise RuntimeError("OpenSubtitles API key is not configured")

    attributes = item.get("attributes", {})
    file_id = None
    if isinstance(attributes.get("files"), list) and len(attributes["files"]) > 0:
        file_id = attributes["files"][0].get("file_id")

    if file_id is None:
        file_id = item.get("file_id")

    if file_id is None:
        fallback_url = attributes.get("url")
        if isinstance(fallback_url, str) and fallback_url:
            logger.info("Falling back to OpenSubtitles item URL", {"url": fallback_url})
            return fallback_url
        raise RuntimeError("Subtitle item has no downloadable source")

    logger.info("Resolving OpenSubtitles download link", {"file_id": file_id})
    response = httpx.post(
        "https://api.opensubtitles.com/api/v1/download",
        headers={
            "Api-Key": api_key,
            "User-Agent": "Stremio Hebrew Subtitles/1.0",
            "Accept": "application/json",
            "Content-Type": "application/json"
        },
        json={"file_id": file_id},
        timeout=30.0
    )

    try:
        data = response.json()
    except Exception as exc:
        logger.error("Failed to parse OpenSubtitles download response", exc_info=exc)
        raise RuntimeError("Invalid OpenSubtitles download response")

    if not response.is_success:
        logger.error("OpenSubtitles download endpoint failed", {"status": response.status_code, "body": data})
        fallback_url = attributes.get("url")
        if isinstance(fallback_url, str) and fallback_url:
            return fallback_url
        raise RuntimeError("Failed to resolve OpenSubtitles download link")

    link = data.get("link") or data.get("url")
    if not isinstance(link, str) or not link:
        logger.error("OpenSubtitles download response missing link", {"body": data})
        fallback_url = attributes.get("url")
        if isinstance(fallback_url, str) and fallback_url:
            return fallback_url
        raise RuntimeError("No download link returned from OpenSubtitles")

    return link
