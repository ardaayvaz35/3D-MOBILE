// Pure helpers for the resumable multipart upload (spec 2026-10-05 §8.2).
import type { MultipartState } from '../house/houseSession';

export function partRange(s: MultipartState, n: number): { position: number; length: number } {
  if (!Number.isInteger(n) || n < 1 || n > s.partCount) throw new Error(`bad part ${n}`);
  const position = (n - 1) * s.partSize;
  return { position, length: Math.min(s.partSize, s.size - position) };
}

export function missingParts(s: MultipartState): number[] {
  const out: number[] = [];
  for (let n = 1; n <= s.partCount; n++) if (!s.etags[n]) out.push(n);
  return out;
}

export function readEtag(headers: Record<string, string>): string | null {
  for (const k of Object.keys(headers)) if (k.toLowerCase() === 'etag') return headers[k] || null;
  return null;
}

export function doneParts(s: MultipartState): { part_number: number; etag: string }[] {
  return Object.keys(s.etags)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => ({ part_number: n, etag: s.etags[n] }));
}

/// R2 aborts unfinished multipart uploads after 7 days; stop trusting a saved one a day earlier.
export function isStale(s: MultipartState, now: number, maxAgeMs: number = 6 * 24 * 3600 * 1000): boolean {
  return s.startedAt == null || now - s.startedAt > maxAgeMs;
}
