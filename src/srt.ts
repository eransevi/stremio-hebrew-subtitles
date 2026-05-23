export type SrtBlock = {
  index: string;
  time: string;
  lines: string[];
};

export function parseSrt(text: string): SrtBlock[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/\n{2,}/)
    .map((rawBlock) => {
      const lines = rawBlock.split("\n");
      const index = lines.shift()?.trim() ?? "";
      const time = lines.shift()?.trim() ?? "";
      return {
        index,
        time,
        lines: lines.map((line) => line.trim())
      };
    })
    .filter((block) => block.index && block.time);
}

export function serializeSrt(blocks: SrtBlock[]): string {
  return blocks
    .map((block) => {
      const lines = [block.index, block.time, ...block.lines];
      return lines.join("\n");
    })
    .join("\n\n");
}
