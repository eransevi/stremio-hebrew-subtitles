import base64
import logging
import os
from typing import Optional

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.responses import JSONResponse

from oci_kv import OracleKvClient
from opensubtitles import rank_subtitles, resolve_subtitle_download_url, search_subtitles
from translation import ensure_translator, translate_subtitle_text

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("argos_subtitles")

app = FastAPI(title="Argos Subtitle Translator")
TRANSLATOR = None
KV_CLIENT: Optional[OracleKvClient] = None


def make_cache_key(imdb_id: str, filename: str) -> str:
    if not imdb_id:
        raise ValueError("imdb_id is required")
    if not filename:
        raise ValueError("filename is required")
    return f"sub:{imdb_id}-{filename}"


def original_key(cache_key: str) -> str:
    return f"{cache_key}-original"


def translation_key(cache_key: str) -> str:
    return f"{cache_key}-translation"


def in_progress_key(cache_key: str) -> str:
    return f"{cache_key}-inprogress"


def get_cached_translation(cache_key: str) -> Optional[str]:
    if KV_CLIENT is None:
        raise RuntimeError("KV client is not initialized")
    logger.info("Checking translation cache", {"cache_key": cache_key})
    return KV_CLIENT.get_string(translation_key(cache_key))


def is_translation_in_progress(cache_key: str) -> bool:
    if KV_CLIENT is None:
        raise RuntimeError("KV client is not initialized")
    return KV_CLIENT.get_string(in_progress_key(cache_key)) is not None


def mark_translation_in_progress(cache_key: str) -> None:
    if KV_CLIENT is None:
        raise RuntimeError("KV client is not initialized")
    logger.info("Marking translation in progress", {"cache_key": cache_key})
    KV_CLIENT.put_string(in_progress_key(cache_key), "1")


def clear_translation_in_progress(cache_key: str) -> None:
    if KV_CLIENT is None:
        raise RuntimeError("KV client is not initialized")
    logger.info("Clearing translation in progress", {"cache_key": cache_key})
    KV_CLIENT.delete_key(in_progress_key(cache_key))


def store_cache_values(cache_key: str, original_text: str, translated_text: str) -> None:
    if KV_CLIENT is None:
        raise RuntimeError("KV client is not initialized")
    logger.info("Persisting cached subtitle values", {"cache_key": cache_key})
    KV_CLIENT.put_string(original_key(cache_key), original_text)
    KV_CLIENT.put_string(translation_key(cache_key), translated_text)


def fetch_subtitle_text(source_url: str) -> str:
    logger.info("Fetching subtitle file", {"url": source_url})
    response = httpx.get(source_url, timeout=60.0)
    if response.status_code != 200:
        logger.error("Failed to fetch subtitle file", {"url": source_url, "status": response.status_code})
        raise RuntimeError(f"Failed to fetch subtitle URL: {response.status_code}")
    return response.text


async def translate_job(cache_key: str, imdb_id: str, filename: str) -> None:
    logger.info("Background translation job started", {"cache_key": cache_key, "imdb_id": imdb_id, "filename": filename})
    try:
        if KV_CLIENT is None:
            raise RuntimeError("KV client is not initialized")

        api_key = os.getenv("OPENSUBTITLES_API_KEY")
        items = search_subtitles(imdb_id, filename, api_key)
        if not items:
            raise RuntimeError("No OpenSubtitles candidates found")

        best_item = rank_subtitles(items)
        download_url = resolve_subtitle_download_url(best_item, api_key)
        source_text = fetch_subtitle_text(download_url)

        logger.info("Translating subtitle file", {"cache_key": cache_key, "length": len(source_text)})
        translated_text = translate_subtitle_text(source_text, TRANSLATOR)

        store_cache_values(cache_key, source_text, translated_text)
        logger.info("Background translation job completed", {"cache_key": cache_key})
    except Exception as exc:
        logger.error("Background translation job failed", exc_info=exc, extra={"cache_key": cache_key, "imdb_id": imdb_id, "filename": filename})
    finally:
        try:
            clear_translation_in_progress(cache_key)
        except Exception as internal_exc:
            logger.error("Failed to clear in-progress marker", exc_info=internal_exc, extra={"cache_key": cache_key})


@app.on_event("startup")
async def startup_event() -> None:
    global TRANSLATOR, KV_CLIENT
    source_lang = os.getenv("ARGOS_SOURCE_LANG", "en")
    target_lang = os.getenv("ARGOS_TARGET_LANG", "he")
    logger.info("Starting server", {"source_lang": source_lang, "target_lang": target_lang})
    TRANSLATOR = ensure_translator(source_lang, target_lang)
    KV_CLIENT = OracleKvClient()
    logger.info("Oracle KV client initialized")


@app.get("/manifest.json")
async def manifest():
    logger.info("Serving manifest")
    return {
        "id": "com.hebrew.subtitles.ai",
        "version": "1.0.0",
        "name": "Hebrew AI Subtitles",
        "resources": ["subtitles"],
        "types": ["movie", "series"],
        "idPrefixes": ["tt"]
    }


@app.get("/subtitles/{imdb_id}")
async def subtitles(imdb_id: str, filename: Optional[str] = None, background_tasks: BackgroundTasks = None):
    if not filename:
        logger.warning("Missing filename parameter for subtitles request", {"imdb_id": imdb_id})
        raise HTTPException(status_code=400, detail="filename query parameter is required")

    cache_key = make_cache_key(imdb_id, filename)
    logger.info("Subtitle request received", {"cache_key": cache_key})

    try:
        translated_text = get_cached_translation(cache_key)
    except Exception as exc:
        logger.error("Failed to read translation cache", exc_info=exc, extra={"cache_key": cache_key})
        raise HTTPException(status_code=500, detail="Cache read failed")

    if translated_text is not None:
        logger.info("Translation cache hit", {"cache_key": cache_key})
        payload = base64.b64encode(translated_text.encode("utf-8")).decode("ascii")
        return JSONResponse(
            {
                "subtitles": [
                    {
                        "id": f"he-{imdb_id}",
                        "lang": "heb",
                        "url": f"data:text/plain;base64,{payload}"
                    }
                ]
            }
        )

    logger.info("Translation cache miss", {"cache_key": cache_key})

    if is_translation_in_progress(cache_key):
        logger.info("Translation already in progress", {"cache_key": cache_key})
    else:
        logger.info("Queueing background translation job", {"cache_key": cache_key})
        mark_translation_in_progress(cache_key)
        background_tasks.add_task(translate_job, cache_key, imdb_id, filename)

    return JSONResponse(
        {
            "subtitles": [],
            "message": "Translation queued. Please retry after it completes."
        }
    )
