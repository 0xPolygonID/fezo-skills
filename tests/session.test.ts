import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadSession, saveSession, sessionPath, validateSessionId } from '../src/engine/session.js';

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
