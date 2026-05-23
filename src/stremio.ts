import { searchSubtitles, resolveSubtitleDownloadUrl } from "./opensubtitles";
import { rankSubtitles } from "./matcher";
import { translateFirstLines } from "./translate";
import { info, warn, error } from "./logger";

function encodeUtf8Base64(text: string) {
  const utf8Bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of utf8Bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function filenameToQuery(filename: string) {
  // Keep the filename as-is, removing only the file extension and trailing .json.
  return filename.replace(/\.json$/i, "").replace(/\.[^.]+$/, "");
}

function buildFilenameQueries(filename: string) {
  const base = filenameToQuery(filename);
  const normalizedSeparators = base.replace(/[._,-]+/g, " ").replace(/\s+/g, " ").trim();
  const normalizedHyphens = base.replace(/[-]+/g, " ").replace(/\s+/g, " ").trim();

  const candidates = [base];
  if (normalizedSeparators && normalizedSeparators !== base) {
    candidates.push(normalizedSeparators);
  }
  if (normalizedHyphens && normalizedHyphens !== base && normalizedHyphens !== normalizedSeparators) {
    candidates.push(normalizedHyphens);
  }

  return [...new Set(candidates)];
}

export async function handleSubtitles(req: Request, env: any) {
  const url = new URL(req.url);
  const parts = url.pathname.split("/");

  const type = parts[2];
  const id = parts[3];
  const imdbId = id?.split(":")[0];
  const extraPath = parts.slice(4).join("/");

  let filename: string | undefined;
  if (extraPath?.startsWith("filename=")) {
    filename = decodeURIComponent(extraPath.slice("filename=".length));
  } else if (extraPath) {
    filename = decodeURIComponent(extraPath);
  }

  if (filename?.endsWith(".json")) {
    filename = filename.slice(0, -".json".length);
  }

  const queryCandidates = filename ? buildFilenameQueries(filename) : [];
  const searchQuery = queryCandidates[0];
  const context = { type, id, imdbId, filename, searchQuery, queryCandidates };
  info("Handling subtitle request", context);

  if (!type || !id || !imdbId) {
    warn("Invalid subtitle request path", url.pathname);
    return new Response("Bad request", { status: 400 });
  }

  const cacheKey = `sub:${imdbId}`;

  try {
    const cached = await env.SUB_CACHE.get(cacheKey);
    if (cached) {
      info("Cache hit", { cacheKey, imdbId });
      return new Response(cached, {
        headers: { "Content-Type": "application/json" }
      });
    }

    info("Cache miss", { cacheKey, imdbId, searchQuery, queryCandidates });

    const originalCacheKey = `${cacheKey}-original`;
    const cachedOriginalSrt = await env.SUB_CACHE.get(originalCacheKey);
    if (cachedOriginalSrt) {
      info("Original SRT cache hit; skipping OpenSubtitles search", {
        cacheKey,
        originalCacheKey,
        imdbId
      });

      const plaintextCacheKey = `${cacheKey}-plaintext`;
      const sampleTranslation = await translateFirstLines(cachedOriginalSrt, env, 6);
      await env.SUB_CACHE.put(plaintextCacheKey, sampleTranslation);
      info("Cached sample first-6-line translation to plaintext KV from cached original SRT", {
        cacheKey,
        plaintextCacheKey,
        sampleLineCount: 6,
        sampleLength: sampleTranslation.length,
        imdbId
      });

      const result = {
        subtitles: [
          {
            id: `en-${imdbId}`,
            lang: "eng",
            url: "data:text/plain;base64," + encodeUtf8Base64(cachedOriginalSrt)
          }
        ]
      };

      await env.SUB_CACHE.put(cacheKey, JSON.stringify(result));
      return Response.json(result);
    }

    const subs = await searchSubtitles(imdbId, queryCandidates, env);
    info("Subtitle search completed", {
      imdbId,
      filename,
      searchQuery,
      queryCandidates,
      count: subs.length
    });

    const best = rankSubtitles(subs);
    info("Selected best subtitle", {
      imdbId,
      subtitleId: best.id,
      downloadCount: best.attributes.download_count,
      sourceUrl: best.attributes?.url,
      fileId: best.attributes?.files?.[0]?.file_id ?? best.attributes?.file_id
    });

    const subtitleUrl = await resolveSubtitleDownloadUrl(best, env);
    info("Resolved subtitle download URL", {
      imdbId,
      subtitleUrl
    });

    const srtRes = await fetch(subtitleUrl, {
      headers: {
        "User-Agent": "Stremio Hebrew Subtitles/1.0",
        "Accept": "text/plain,application/octet-stream,*/*"
      }
    });
    info("Fetched SRT URL", {
      url: subtitleUrl,
      status: srtRes.status,
      contentType: srtRes.headers.get("content-type")
    });

    if (!srtRes.ok) {
      const body = await srtRes.text().catch(() => "<unreadable body>");
      error("Failed to download subtitle file", {
        url: subtitleUrl,
        status: srtRes.status,
        body
      });
      throw new Error("Failed to fetch subtitle file");
    }

    const contentType = srtRes.headers.get("content-type") || "";
    if (contentType.includes("text/html") || contentType.includes("application/json")) {
      const body = await srtRes.text().catch(() => "<unreadable body>");
      error("Subtitle download link returned non-text content", {
        url: subtitleUrl,
        contentType,
        bodySnippet: body.slice(0, 512)
      });
      throw new Error("Subtitle download returned invalid content type");
    }

    const srtText = await srtRes.text();
    info("Downloaded SRT text", {
      length: srtText.length,
      imdbId
    });

    await env.SUB_CACHE.put(originalCacheKey, srtText);
    info("Cached original SRT text", {
      originalCacheKey,
      imdbId
    });

    const plaintextCacheKey = `${cacheKey}-plaintext`;
    const sampleTranslation = await translateFirstLines(srtText, env, 6);
    await env.SUB_CACHE.put(plaintextCacheKey, sampleTranslation);
    info("Cached sample first-6-line translation to plaintext KV", {
      plaintextCacheKey,
      sampleLineCount: 6,
      sampleLength: sampleTranslation.length
    });

    const result = {
      subtitles: [
        {
          id: `en-${imdbId}`,
          lang: "eng",
          url: "data:text/plain;base64," + encodeUtf8Base64(srtText)
        }
      ]
    };

    await env.SUB_CACHE.put(cacheKey, JSON.stringify(result));
    info("Cached original subtitles response and sample plaintext translation", {
      cacheKey,
      plaintextCacheKey,
      originalCacheKey,
      imdbId
    });

    return Response.json(result);
  } catch (err) {
    error("Subtitle handling failed", {
      request: context,
      error: err
    });

    return new Response(
      JSON.stringify({
        error: "Subtitle processing failed"
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}