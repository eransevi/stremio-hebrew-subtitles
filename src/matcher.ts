import { info, error } from "./logger";

export function rankSubtitles(subs: any[]) {
  if (!subs.length) {
    error("No subtitles found to rank");
    throw new Error("No subtitles found");
  }

  const candidateSummaries = subs.slice(0, 10).map((item) => ({
    id: item.id,
    release: item.attributes?.release,
    language: item.attributes?.language,
    download_count: item.attributes?.download_count,
    url: item.attributes?.url
  }));

  info("Matcher input candidates", {
    count: subs.length,
    sample: candidateSummaries
  });

  const ranked = subs
    .slice()
    .sort((a, b) => {
      const aCount = a?.attributes?.download_count || 0;
      const bCount = b?.attributes?.download_count || 0;
      return bCount - aCount;
    });

  const best = ranked[0];

  if (!best || !best.attributes || !best.attributes.url) {
    error("Best subtitle item is missing required URL", {
      bestCandidate: best
    });
    throw new Error("Subtitle item missing URL");
  }

  info("Ranked subtitles", {
    bestId: best.id,
    release: best.attributes?.release,
    language: best.attributes?.language,
    downloadCount: best.attributes?.download_count || 0,
    url: best.attributes?.url,
    candidates: ranked.length
  });

  return best;
}