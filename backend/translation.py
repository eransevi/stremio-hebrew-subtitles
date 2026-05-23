import logging
import re
from typing import List

from argostranslate import translate

logger = logging.getLogger("argos_subtitles.translation")

TIMING_PATTERN = re.compile(
    r'^\d+$|^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}|^Dialogue:',
    re.IGNORECASE
)


def is_timing(line: str) -> bool:
    return bool(TIMING_PATTERN.match(line.strip()))


def clean_text(line: str) -> str:
    line = re.sub(r'<[^>]+>', '', line)
    line = re.sub(r'^-\s*', '', line)
    line = re.sub(r'\[.*?\]', '', line)
    return line.strip()


def ensure_translator(source_lang: str = "en", target_lang: str = "he"):
    langs = translate.get_installed_languages()
    source = next((lang for lang in langs if lang.code == source_lang), None)
    target = next((lang for lang in langs if lang.code == target_lang), None)
    if source is None or target is None:
        raise RuntimeError(
            f"Argos Translate language pair not installed: {source_lang} -> {target_lang}. "
            "Install the model package before starting the server."
        )
    return source.get_translation(target)


def normalize_translated_lines(translated_lines: List[str], original_count: int, fallback: List[str]) -> List[str]:
    if len(translated_lines) == original_count:
        return translated_lines

    if len(translated_lines) == 0:
        return fallback

    if len(translated_lines) == 1 and original_count > 1:
        return [translated_lines[0]] * original_count

    if len(translated_lines) < original_count:
        padding = [translated_lines[-1]] * (original_count - len(translated_lines))
        return translated_lines + padding

    return translated_lines[:original_count]


def translate_block(lines: List[str], translator) -> List[str]:
    cleaned_lines = [clean_text(line) or line for line in lines]
    block_text = "\n".join(cleaned_lines)
    logger.debug("Translating subtitle block", {"block_length": len(block_text), "line_count": len(lines)})
    translated = translator.translate(block_text).strip()
    translated_lines = [ln.strip() for ln in translated.replace('\r\n', '\n').split('\n') if ln.strip()]
    return normalize_translated_lines(translated_lines, len(lines), lines)


def translate_subtitle_text(text: str, translator) -> str:
    normalized = text.replace('\r\n', '\n').replace('\r', '\n')
    lines = normalized.split('\n')
    output_lines: List[str] = []
    i = 0

    while i < len(lines):
        line = lines[i]
        if is_timing(line):
            output_lines.append(line)
            i += 1
            block: List[str] = []
            while i < len(lines) and lines[i].strip() and not is_timing(lines[i]):
                block.append(lines[i])
                i += 1
            if block:
                output_lines.extend(translate_block(block, translator))
            continue

        output_lines.append(line)
        i += 1

    result = "\n".join(output_lines)
    logger.info("Subtitle translation complete", {"length": len(result)})
    return result
