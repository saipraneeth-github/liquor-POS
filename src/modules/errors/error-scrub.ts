import { createHash } from 'node:crypto';

/** PURE helpers of the built-in error tracker (no database), so they can be unit-tested on their own. */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Masks what could identify a person before anything is stored. */
export function scrub(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b\d{9,}\b/g, '[number]');
}

export const stripQuery = (url: string | null | undefined) => (url ? url.split('?')[0].slice(0, 300) : null);

/**
 * The same bug seen a thousand times is ONE row. The key is the source, the message with the parts that differ between
 * occurrences removed (ids, numbers) and the first stack frame without its line / column.
 */
export function fingerprintOf(source: string, message: string, stack?: string | null): string {
  const msg = message.replace(UUID, '<id>').replace(/\d+/g, '<n>').slice(0, 200);
  const frame = (stack ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('at ') || l.includes('@')) ?? '';
  const where = frame.replace(/:\d+:\d+\)?$/, '').replace(/\d+/g, '<n>').slice(0, 200);
  return createHash('sha1').update(`${source}|${msg}|${where}`).digest('hex');
}
