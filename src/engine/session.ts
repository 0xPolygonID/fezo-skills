// Cross-round state for a multi-round research run: which URLs this session has
// already returned, which queries it has already run, and how much it has
// billed.
//
// This is what makes round 5 as cheap as round 1: without it, every round
// re-returns (and the agent re-reads) the same links, and the cost of a
// research run grows quadratically in rounds rather than linearly.
//
// A CACHE, never a credential store: it holds URLs and query strings, no
// secrets. It still writes 0600 -- a research history is a record of what
// someone was investigating, which is not a thing to leave world-readable.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Bounds on what one session file retains.
 *
 * A research session is read and rewritten on every round, so an unbounded
 * history makes each round pay a growing parse-and-write cost. The value of an
 * old entry decays too: suppression exists so a follow-up round does not
 * re-return what the agent has just read, and the oldest URLs are the ones it
 * has most likely finished with. Exceeding the bound costs at worst one
 * duplicate row, never a wrong answer -- which is why bounding is safe here and
 * would not be in, say, a billing ledger.
 *
 * 2000 URLs is roughly 80 full research rounds at 24 calls each.
 */
export const SESSION_MAX_SEEN_URLS = 2000;
export const SESSION_MAX_QUERIES = 500;

export interface SessionState {
  id: string;
  /** Canonical URLs (aggregate.ts's `canonicalizeUrl` form) already returned. */
  seenUrls: string[];
  queries: string[];
  callsBilled: number;
}

/** The id becomes a filename, so it is validated as one -- no separators, no
 * traversal, no surprises. Rejected during argv parsing (exit 1). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function validateSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id) || id === '.' || id === '..') {
    throw new Error('session id must be 1-64 characters of letters, digits, dot, dash or underscore');
  }
}

export function sessionPath(id: string, env: Record<string, string | undefined>, home: string): string {
  const base = env['XDG_CACHE_HOME'] !== undefined && env['XDG_CACHE_HOME'] !== ''
    ? env['XDG_CACHE_HOME']
    : join(home, '.cache');
  return join(base, 'fezo', 'sessions', `${id}.json`);
}

/**
 * Reads a session, or an empty one if it does not exist or cannot be read.
 *
 * Never throws on a damaged file: a corrupt cache must degrade to "this round
 * suppresses nothing", not fail a round the caller is about to pay for.
 */
export function loadSession(id: string, env: Record<string, string | undefined>, home: string): SessionState {
  const empty: SessionState = { id, seenUrls: [], queries: [], callsBilled: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sessionPath(id, env, home), 'utf8'));
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const record = parsed as Partial<SessionState>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return {
    id,
    seenUrls: strings(record.seenUrls),
    queries: strings(record.queries),
    callsBilled: typeof record.callsBilled === 'number' ? record.callsBilled : 0,
  };
}

export function saveSession(state: SessionState, env: Record<string, string | undefined>, home: string): void {
  const path = sessionPath(state.id, env, home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
