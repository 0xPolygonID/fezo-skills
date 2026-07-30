// MCP-compatible tool-name algorithm. Ported verbatim from
// zug/mcp-server/src/tool_name.ts and zug/mcp-server/src/const.ts so tool
// names fezoctl derives here match the ones the existing MCP server would
// derive from the same catalog.

import { createHash } from 'node:crypto';

/** Max length of an exposed MCP tool name. Verbatim from the apify fork. */
export const MAX_TOOL_NAME_LENGTH = 64;
/** Length of the hash suffix appended to truncated/colliding names. */
export const TOOL_NAME_HASH_LENGTH = 4;

/**
 * Builds a unique, charset-safe MCP tool name from a backend id and method
 * name. Coerces to ^[a-zA-Z0-9_-]+$, then caps length with a sha256 suffix
 * for uniqueness on truncation or intra-backend duplicate method names.
 */
export function methodToToolName(backendId: string, methodName: string): string {
  const raw = `${backendId}_${methodName}`;
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (sanitized.length <= MAX_TOOL_NAME_LENGTH) return sanitized;

  const hash = createHash('sha256').update(raw).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
  return `${sanitized.slice(0, MAX_TOOL_NAME_LENGTH - TOOL_NAME_HASH_LENGTH - 1)}-${hash}`;
}

/**
 * Resolves a tool name back to the candidate it was derived from.
 *
 * A hash-capped tool name is lossy (the original backend id/method boundary
 * is not recoverable from the string alone), and both backend ids and method
 * names may themselves contain underscores, so splitting a tool name on `_`
 * to recover `{backendId}_{method}` is unsound in general. The only correct
 * resolution is to rebuild the candidate list: recompute
 * `methodToToolName(candidate.backendId, candidate.method)` for every known
 * candidate and match on equality.
 */
export function findCandidateByToolName<T extends { backendId: string; method: string }>(
  candidates: readonly T[],
  toolName: string,
): T | undefined {
  return candidates.find((candidate) => methodToToolName(candidate.backendId, candidate.method) === toolName);
}
