import type { Line } from './types';

/** Read every page so a large statement cannot appear finished after its first 500 rows. */
export async function readStatementLines(read: (offset: number) => Promise<Line[]>): Promise<Line[]> {
  const lines: Line[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await read(offset);
    lines.push(...page);
    if (page.length < 500) return lines;
  }
}
