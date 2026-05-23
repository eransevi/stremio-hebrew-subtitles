import { info, warn, error } from "./logger";
import { parseSrt, serializeSrt, SrtBlock } from "./srt";

function hasHebrew(text: string) {
  return /[\u0590-\u05FF]/.test(text);
}

function getTranslatedText(result: any): string | undefined {
  if (!result) {
    return undefined;
  }

  if (typeof result.translated_text === "string") {
    return result.translated_text;
  }

  if (typeof result.output === "string") {
    return result.output;
  }

  if (Array.isArray(result.output)) {
    return result.output
      .map((item: any) => {
        if (typeof item === "string") {
          return item;
        }
        if (typeof item?.content === "string") {
          return item.content;
        }
        return undefined;
      })
      .filter(Boolean)
      .join("\n");
  }

  if (Array.isArray(result.choices) && result.choices.length > 0) {
    const choice = result.choices[0];
    if (typeof choice.text === "string") {
      return choice.text;
    }
    if (typeof choice?.message?.content === "string") {
      return choice.message.content;
    }
  }

  if (typeof result.text === "string") {
    return result.text;
  }

  if (typeof result.response === "string") {
    return result.response;
  }

  return undefined;
}

function getTranslationModel(env: any) {
  return env?.AI_MODEL || "@cf/meta/m2m100-1.2b";
}

function getAiErrorData(err: any, modelOrProvider: string) {
  return {
    model: modelOrProvider,
    message: err?.message ?? String(err),
    stack: err?.stack,
    error: err
  };
}

function buildAiRunOptions(model: string, text: string) {
  const options: any = { text };
  options.source_lang = "english";
  options.target_lang = "hebrew";
  return options;
}

async function runAiModel(model: string, text: string, env: any) {
  const options = buildAiRunOptions(model, text);
  info("Calling Cloudflare AI model", {
    model,
    sourceLang: options.source_lang,
    targetLang: options.target_lang,
    textLength: text.length
  });
  return env.AI.run(model, options);
}

function isBadTranslation(source: string, translated: string) {

  if (!translated || translated.trim().length === 0) {
    return true;
  }

  if (!hasHebrew(translated)) {
    return true;
  }

  const sourceLines = source.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  const translatedLines = translated.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (translatedLines.length === 0) {
    return true;
  }

  if (translatedLines.length > sourceLines.length * 3) {
    return true;
  }

  const sourceBlockCount = parseSrt(source).length;
  if (sourceBlockCount > 0 && parseSrt(translated).length !== sourceBlockCount) {
    return true;
  }

  const repeatMatch = /(\b.+\b)\s+\1\s+\1/;
  if (repeatMatch.test(translated)) {
    return true;
  }

  return false;
}

export function buildSampleSrt(blocks: SrtBlock[], translatedLines: string[], maxLines: number) {
  let remaining = maxLines;
  let translationIndex = 0;

  return blocks.map((block) => {
    if (remaining <= 0) {
      return block;
    }

    const replacedLines = block.lines.map((line) => {
      if (remaining <= 0) {
        return line;
      }

      const replacement = translatedLines[translationIndex];
      translationIndex += 1;
      remaining -= 1;

      return replacement ?? line;
    });

    return {
      ...block,
      lines: replacedLines
    };
  });
}

export async function translateFirstLines(text: string, env: any, maxLines = 6) {
  if (!env?.AI?.run) {
    error("Cloudflare AI binding is missing or invalid");
    throw new Error("Cloudflare AI binding is not configured");
  }

  const blocks = parseSrt(text);
  const sourceLines = blocks.flatMap((block) => block.lines).slice(0, maxLines);
  if (sourceLines.length === 0) {
    return "";
  }

  const sourceText = sourceLines.join("\n");
  info("Starting transcription sample", {
    sampleLines: sourceLines.length,
    sampleInput: sourceText,
    batchSize: 2,
    expectedCalls: Math.ceil(sourceLines.length / 2)
  });

  const model = getTranslationModel(env);
  const translatedLines: string[] = [];
  const chunkSize = 2;

  for (let chunkStart = 0; chunkStart < sourceLines.length; chunkStart += chunkSize) {
    const chunk = sourceLines.slice(chunkStart, chunkStart + chunkSize);
    const chunkText = chunk.join("\n");
    const result = await runAiModel(model, chunkText, env);
    const rawTranslation = getTranslatedText(result) ?? "";
    let chunkTranslations = rawTranslation
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (chunkTranslations.length === 0) {
      chunkTranslations = [...chunk];
    }

    while (chunkTranslations.length < chunk.length) {
      chunkTranslations.push(chunk[chunkTranslations.length] ?? "");
    }

    if (chunkTranslations.length > chunk.length) {
      chunkTranslations = chunkTranslations.slice(0, chunk.length);
    }

    info("Transcription chunk result", {
      chunkIndex: chunkStart / chunkSize + 1,
      inputText: chunkText,
      outputLines: chunkTranslations
    });

    translatedLines.push(...chunkTranslations);
  }

  const sampleBlocks = buildSampleSrt(blocks, translatedLines, maxLines);
  const sampleSrt = serializeSrt(sampleBlocks);
  info("Completed transcription sample", {
    sampleOutput: sampleSrt
  });

  return sampleSrt;
}

async function translateFullSrt(text: string, env: any) {
  if (!env?.AI?.run) {
    error("Cloudflare AI binding is missing or invalid");
    throw new Error("Cloudflare AI binding is not configured");
  }

  const blocks = parseSrt(text);
  const blockCount = blocks.length;
  const formatHint = blockCount
    ? `This subtitle file contains ${blockCount} blocks. Each block has an index line, a timestamp line, one or more dialogue lines, and is separated by a blank line.`
    : "This text is an English subtitle file. Preserve the subtitle structure and line breaks.";

  const prompt = `Translate the following English subtitle file to Hebrew.

${formatHint}

- Preserve the exact subtitle file format, including index numbers, timestamps, blank lines, and line breaks.
- Only translate the subtitle dialogue text; do not change timestamps, indexes, formatting, or punctuation.
- Keep the same number of subtitle entries and the same line structure.
- Do not add explanations, comments, or extra text before or after the file.
- If you cannot output valid SRT, return the original file exactly as-is.
- Output only the translated subtitle file in valid SRT format.

${text}`;

  let translatedText: string;
  const model = getTranslationModel(env);
  info("Using AI model", { model, configuredModel: env?.AI_MODEL });

  try {
    const result = await runAiModel(model, prompt, env);
    translatedText = getTranslatedText(result) ?? "";
  } catch (err) {
    error("AI translation request failed", getAiErrorData(err, model));
    throw err;
  }

  if (!translatedText) {
    warn("AI returned unexpected translation response", { model });
    translatedText = "";
  }

  const normalizedSource = text.trim();
  const normalizedTranslation = translatedText.trim();

  if (
    normalizedTranslation === normalizedSource ||
    isBadTranslation(text, normalizedTranslation)
  ) {
    warn("First translation attempt looked invalid; retrying with stronger instructions", {
      translatedSnippet: normalizedTranslation.slice(0, 256)
    });

    const retryPrompt = `Translate the following English subtitle file to Hebrew.

${formatHint}

- Preserve the exact subtitle file format, including index numbers, timestamps, blank lines, and line breaks.
- Only translate the subtitle dialogue text; do not change timestamps, indexes, formatting, or punctuation.
- Keep the same number of subtitle entries and the same line structure.
- Do not add explanations, comments, or extra text before or after the file.
- Use Hebrew letters for all translated dialogue text; do not preserve any English words.
- If you cannot output valid SRT, return the original file exactly as-is.

${text}`;

    try {
      const retryResult = await runAiModel(model, retryPrompt, env);
      translatedText = getTranslatedText(retryResult) ?? "";
    } catch (err) {
      error("AI retry translation request failed", getAiErrorData(err, model));
      throw err;
    }
  }

  if (!translatedText || isBadTranslation(text, translatedText)) {
    const errorData = {
      translatedSnippet: translatedText?.slice(0, 256),
      originalSample: text.slice(0, 256),
      model,
      promptLength: prompt.length
    };
    error("Final translation output did not pass quality checks", errorData);
    throw new Error("AI translation output failed quality checks");
  }

  return translatedText;
}

export async function translateToHebrew(text: string, env: any) {
  info("Starting translation", { textLength: text.length });

  const blocks = parseSrt(text);
  info("Parsed SRT blocks", { blockCount: blocks.length });

  const translated = await translateFullSrt(text, env);
  info("AI translation result received", {
    translatedLength: translated.length,
    parsedBlockCount: blocks.length
  });
  return translated;
}