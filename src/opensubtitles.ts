import { info, warn, error } from "./logger";

export async function searchSubtitles(imdbId: string, queries: string[] | undefined, env: any) {
  const queryCandidates = Array.isArray(queries) ? queries : queries ? [queries] : [];
  info("Searching OpenSubtitles for IMDb ID", { imdbId, queryCandidates });

  const apiKey = env.OPENSUBTITLES_API_KEY;
  if (!apiKey) {
    error("Missing OpenSubtitles API key");
    throw new Error("OpenSubtitles API key is not configured");
  }

  const actuallyQuery = async (query?: string) => {
    const params = new URLSearchParams({
      imdb_id: imdbId,
      languages: "en"
    });
    if (query) {
      params.set("query", query);
    }

    const res = await fetch(
      `https://api.opensubtitles.com/api/v1/subtitles?${params.toString()}`,
      {
        headers: {
          "Api-Key": apiKey,
          "User-Agent": "Stremio Hebrew Subtitles/1.0",
          "Accept": "application/json"
        }
      }
    );

    info("OpenSubtitles API response", {
      imdbId,
      query,
      status: res.status
    });

    const body = await res.text();
    let data: any;

    try {
      data = JSON.parse(body);
    } catch (parseError) {
      error("Failed to parse OpenSubtitles response", {
        imdbId,
        query,
        status: res.status,
        parseError,
        body
      });
      throw new Error("Invalid OpenSubtitles response");
    }

    if (!res.ok) {
      error("OpenSubtitles API error", {
        imdbId,
        query,
        status: res.status,
        response: data
      });
      throw new Error("OpenSubtitles API request failed");
    }

    const items: any[] = data.data || [];
    const itemSummaries = items.slice(0, 10).map((item) => ({
      id: item.id,
      release: item.attributes?.release,
      language: item.attributes?.language,
      download_count: item.attributes?.download_count,
      url: item.attributes?.url,
      file_id: item.attributes?.files?.[0]?.file_id ?? item.attributes?.file_id
    }));

    info("OpenSubtitles subtitle candidates", {
      imdbId,
      query,
      total: items.length,
      sample: itemSummaries
    });

    return items;
  };

  const triedQueries: any[] = [];
  if (queryCandidates.length === 0) {
    const items = await actuallyQuery();
    triedQueries.push({ query: undefined, count: items.length });
    info("OpenSubtitles search result", {
      imdbId,
      triedQueries
    });
    return items;
  }

  for (const query of queryCandidates) {
    const items = await actuallyQuery(query);
    triedQueries.push({ query, count: items.length });
    if (items.length > 0) {
      info("OpenSubtitles search result", {
        imdbId,
        triedQueries,
        selectedQuery: query
      });
      return items;
    }
  }

  info("OpenSubtitles search returned no results for any query", {
    imdbId,
    triedQueries
  });
  return [];
}

export async function resolveSubtitleDownloadUrl(item: any, env: any) {
  const apiKey = env.OPENSUBTITLES_API_KEY;
  if (!apiKey) {
    error("Missing OpenSubtitles API key for download resolution");
    throw new Error("OpenSubtitles API key is not configured");
  }

  const fileId =
    item.attributes?.files?.[0]?.file_id ??
    item.attributes?.file_id;

  if (!fileId) {
    const fallbackUrl = item.attributes?.url;
    info("No file_id available; falling back to attributes.url", {
      id: item.id,
      fallbackUrl
    });

    if (typeof fallbackUrl === "string" && fallbackUrl.length) {
      return fallbackUrl;
    }

    error("Subtitle item has no file_id or fallback URL", { item });
    throw new Error("Subtitle item has no downloadable source");
  }

  info("Resolving OpenSubtitles download link", {
    id: item.id,
    fileId
  });

  const downloadRes = await fetch("https://api.opensubtitles.com/api/v1/download", {
    method: "POST",
    headers: {
      "Api-Key": apiKey,
      "User-Agent": "Stremio Hebrew Subtitles/1.0",
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ file_id: fileId })
  });

  const downloadBody = await downloadRes.text();
  let downloadData: any;

  try {
    downloadData = JSON.parse(downloadBody);
  } catch (parseError) {
    error("Failed to parse OpenSubtitles download response", {
      id: item.id,
      fileId,
      status: downloadRes.status,
      parseError,
      downloadBody
    });
    throw new Error("Invalid OpenSubtitles download response");
  }

  info("OpenSubtitles download response", {
    id: item.id,
    fileId,
    status: downloadRes.status,
    downloadData
  });

  if (!downloadRes.ok) {
    error("OpenSubtitles download endpoint failed", {
      id: item.id,
      fileId,
      status: downloadRes.status,
      response: downloadData
    });
    const fallbackUrl = item.attributes?.url;
    if (typeof fallbackUrl === "string" && fallbackUrl.length) {
      return fallbackUrl;
    }
    throw new Error("Failed to resolve OpenSubtitles download link");
  }

  const link =
    typeof downloadData?.link === "string"
      ? downloadData.link
      : typeof downloadData?.url === "string"
      ? downloadData.url
      : undefined;

  if (!link) {
    error("OpenSubtitles download response has no link", {
      id: item.id,
      fileId,
      downloadData
    });
    const fallbackUrl = item.attributes?.url;
    if (typeof fallbackUrl === "string" && fallbackUrl.length) {
      return fallbackUrl;
    }
    throw new Error("No download link returned from OpenSubtitles");
  }

  return link;
}
