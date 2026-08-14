import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SESSION_MAX_QUERIES, SESSION_MAX_SEEN_URLS, loadSession, saveSession, sessionPath, validateSessionId } from '../src/engine/session.js';

function scratch(): { env: Record<string, string | undefined>; home: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fezo-session-'));
  return { env: { XDG_CACHE_HOME: dir }, home: dir };
}

describe('validateSessionId', () => {
  it('accepts an ordinary id', () => {
    expect(() => validateSessionId('r-42_a.b')).not.toThrow();
  });

  it('rejects a path separator', () => {
    expect(() => validateSessionId('../escape')).toThrow(/session id/i);
  });

  it('rejects an empty id', () => {
    expect(() => validateSessionId('')).toThrow(/session id/i);
  });
});

describe('sessionPath', () => {
  it('honours XDG_CACHE_HOME', () => {
    expect(sessionPath('r-1', { XDG_CACHE_HOME: '/c' }, '/h')).toBe('/c/fezo/sessions/r-1.json');
  });

  it('falls back to ~/.cache', () => {
    expect(sessionPath('r-1', {}, '/h')).toBe('/h/.cache/fezo/sessions/r-1.json');
  });
});

describe('load/save', () => {
  it('returns an empty state for an unknown session', () => {
    const { env, home } = scratch();
    expect(loadSession('new', env, home)).toEqual({ id: 'new', seenUrls: [], queries: [], callsBilled: 0 });
  });

  it('round-trips state', () => {
    const { env, home } = scratch();
    saveSession({ id: 'r-1', seenUrls: ['https://a.example'], queries: ['q'], callsBilled: 3 }, env, home);
    expect(loadSession('r-1', env, home).seenUrls).toEqual(['https://a.example']);
  });

  it('writes the file 0600', () => {
    const { env, home } = scratch();
    saveSession({ id: 'r-1', seenUrls: [], queries: [], callsBilled: 0 }, env, home);
    expect(statSync(sessionPath('r-1', env, home)).mode & 0o777).toBe(0o600);
  });

  it('returns an empty state rather than throwing on a corrupt file', () => {
    const { env, home } = scratch();
    saveSession({ id: 'r-1', seenUrls: ['https://a.example'], queries: [], callsBilled: 0 }, env, home);
    writeFileSync(sessionPath('r-1', env, home), '{not json');
    expect(loadSession('r-1', env, home).seenUrls).toEqual([]);
  });
});

describe('bounded history', () => {
  it('keeps only the newest SESSION_MAX_SEEN_URLS entries', () => {
    const { env, home } = scratch();
    const urls = Array.from({ length: SESSION_MAX_SEEN_URLS + 10 }, (_u, i) => `https://u${String(i)}.example`);
    saveSession({ id: 'r-1', seenUrls: urls, queries: [], callsBilled: 0 }, env, home);
    const loaded = loadSession('r-1', env, home);
    expect(loaded.seenUrls).toHaveLength(SESSION_MAX_SEEN_URLS);
    // Newest kept: the last URL written must survive, the first must not.
    expect(loaded.seenUrls.at(-1)).toBe(`https://u${String(SESSION_MAX_SEEN_URLS + 9)}.example`);
    expect(loaded.seenUrls).not.toContain('https://u0.example');
  });

  it('bounds queries too, and enforces it inside saveSession rather than at a call site', () => {
    const { env, home } = scratch();
    const queries = Array.from({ length: SESSION_MAX_QUERIES + 5 }, (_u, i) => `q${String(i)}`);
    saveSession({ id: 'r-2', seenUrls: [], queries, callsBilled: 0 }, env, home);
    expect(loadSession('r-2', env, home).queries).toHaveLength(SESSION_MAX_QUERIES);
  });
});
