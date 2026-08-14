import { describe, expect, it } from 'vitest';

import { heuristicPlanner, resolvePlanner } from '../src/engine/planners/heuristic.js';
import type { Intent } from '../src/engine/intent.js';
import type { PlanDepth } from '../src/engine/plan.js';

const plan = (prompt: string) => heuristicPlanner.plan(prompt);

interface Row {
  prompt: string;
  intents: Intent[];
  queries: string[];
  targets: string[];
  depth: PlanDepth;
  fanout: number;
}

// A long prompt in a non-Latin script. Present because the word tables are
// English-only: nothing here can match, so the row pins the one thing the
// planner must still get right for such a prompt -- its length, and therefore
// its depth.
const CYRILLIC_PROMPT = 'как современные языковые модели обрабатывают длинные контексты и почему это важно для практических задач сегодня';

/** The whole planner as a table, which is how the spec (§ Testing) asks for it:
 * one prompt in, the entire routing decision out. Signals are asserted
 * separately, exactly, below. */
const ROWS: Row[] = [
  // A URL and nothing else to search for: fetch it, do not invent a query.
  { prompt: 'summarise https://example.com/pricing', intents: ['scrape'], queries: [], targets: ['https://example.com/pricing'], depth: 'shallow', fanout: 2 },
  // The same prompt as a sentence. The full stop belongs to the sentence, not
  // to the address, and a target is billed verbatim by the scrape provider.
  { prompt: 'summarise https://example.com/pricing.', intents: ['scrape'], queries: [], targets: ['https://example.com/pricing'], depth: 'shallow', fanout: 2 },
  // Two URLs joined by prose: the comma is punctuation, not part of the second.
  { prompt: 'see https://example.com/a. and also https://example.com/b,', intents: ['scrape'], queries: [], targets: ['https://example.com/a', 'https://example.com/b'], depth: 'shallow', fanout: 2 },
  { prompt: 'https://example.com', intents: ['scrape'], queries: [], targets: ['https://example.com'], depth: 'shallow', fanout: 2 },
  // A parenthesised address, the shape Wikipedia and MSDN use to disambiguate.
  // The closing paren is part of the address; cutting it spends a billed fetch
  // on a URL that does not resolve.
  { prompt: 'summarise https://en.wikipedia.org/wiki/Merkle_tree_(data_structure) for me', intents: ['scrape'], queries: [], targets: ['https://en.wikipedia.org/wiki/Merkle_tree_(data_structure)'], depth: 'shallow', fanout: 2 },
  // The mirror case: the same character, owned by the sentence rather than the
  // address. Only the paren balance inside the match tells the two apart.
  { prompt: 'see (https://example.com/a) for details', intents: ['scrape'], queries: [], targets: ['https://example.com/a'], depth: 'shallow', fanout: 2 },
  { prompt: 'check [the docs](https://example.com/docs)', intents: ['scrape'], queries: [], targets: ['https://example.com/docs'], depth: 'shallow', fanout: 2 },
  { prompt: 'what is a merkle tree', intents: ['search'], queries: ['what is a merkle tree'], targets: [], depth: 'standard', fanout: 4 },
  { prompt: 'best rust web frameworks', intents: ['search'], queries: ['best rust web frameworks'], targets: [], depth: 'shallow', fanout: 2 },
  { prompt: 'rust release date', intents: ['search'], queries: ['rust release date'], targets: [], depth: 'shallow', fanout: 2 },
  { prompt: 'how does the borrow checker handle closures in practice', intents: ['search'], queries: ['how does the borrow checker handle closures in practice'], targets: [], depth: 'standard', fanout: 4 },
  { prompt: 'latest coverage of the EU AI Act', intents: ['search', 'news'], queries: ['latest coverage of the EU AI Act'], targets: [], depth: 'shallow', fanout: 2 },
  // A recency cue that spans a word boundary: only reachable by scanning the
  // text, since no token can contain a space.
  { prompt: 'what happened this week in AI', intents: ['search', 'news'], queries: ['what happened this week in AI'], targets: [], depth: 'standard', fanout: 4 },
  // The negative that makes the phrase table's word boundary load-bearing:
  // "this week" and "this year" both live inside ordinary nouns, and a bare
  // substring test would add a `news` lane to a prompt with no time reference.
  { prompt: 'catalogue this yearbook of student photos please', intents: ['search'], queries: ['catalogue this yearbook of student photos please'], targets: [], depth: 'shallow', fanout: 2 },
  // A URL plus prose wants both the page and the topic, and the query must not
  // keep the hole the URL left behind.
  { prompt: 'what does https://example.com say about pricing', intents: ['scrape', 'search'], queries: ['what does say about pricing'], targets: ['https://example.com'], depth: 'standard', fanout: 4 },
  { prompt: 'do comprehensive research on solid-state batteries', intents: ['search'], queries: ['do comprehensive research on solid-state batteries'], targets: [], depth: 'research', fanout: 8 },
  // "literature" alone is ordinary prose; only the breadth-carrying compound
  // buys the 8-lane fan-out.
  { prompt: 'The Great Gatsby literature analysis', intents: ['search'], queries: ['The Great Gatsby literature analysis'], targets: [], depth: 'shallow', fanout: 2 },
  { prompt: 'literature review of transformer scaling laws', intents: ['search'], queries: ['literature review of transformer scaling laws'], targets: [], depth: 'research', fanout: 8 },
  { prompt: CYRILLIC_PROMPT, intents: ['search'], queries: [CYRILLIC_PROMPT], targets: [], depth: 'standard', fanout: 4 },
  // A whitespace-only prompt. Pinned because it is the one input for which the
  // planner returns a plan with neither a query nor a target -- something
  // `parsePlanJson` rejects on the `--plan-json` path. Deliberate: an empty
  // prompt is cli.ts's usage error (exit 1) to catch before anything is
  // billed, so the planner stays total instead of throwing here.
  { prompt: '   ', intents: ['search'], queries: [], targets: [], depth: 'shallow', fanout: 2 },
];

describe('heuristicPlanner: prompt -> plan', () => {
  it.each(ROWS)('routes $prompt', ({ prompt, intents, queries, targets, depth, fanout }) => {
    const p = plan(prompt);
    expect(p.intents).toEqual(intents);
    expect(p.queries).toEqual(queries);
    expect(p.targets).toEqual(targets);
    expect(p.depth).toBe(depth);
    expect(p.fanout).toBe(fanout);
  });
});

describe('heuristicPlanner: transparency', () => {
  // Exact arrays, not a length: `signals` is the explanation a human and an
  // agent read to decide what to override, so a missing entry and a duplicated
  // one are both defects, and only an exact assertion catches either.
  it('explains a URL-only prompt with no query', () => {
    expect(plan('latest news about https://example.com').signals).toEqual([
      'url-literal:1', 'short-prompt:3-tokens', 'targets-only',
    ]);
  });

  it('names the question cue once, distinguishing intent from depth', () => {
    expect(plan('what is a merkle tree').signals).toEqual(['question-form', 'depth:question-form']);
  });

  it('records the phrase that bought the research fan-out and its limitation', () => {
    expect(plan('literature review of transformer scaling laws').signals).toEqual([
      'research-phrase:literature review',
      'no-decomposition: heuristic cannot split this into sub-queries; supply --queries',
    ]);
  });

  it('records the recency cue that added news', () => {
    expect(plan('what happened this week in AI').signals).toEqual([
      'question-form', 'recency-cue', 'depth:question-form',
    ]);
  });

  it('says plainly that an empty prompt matched nothing', () => {
    // The two signals are the whole explanation for a plan that can do
    // nothing: no cue fired, and there were no tokens to fire on. A caller
    // seeing these knows the emptiness came from the input, not from a
    // heuristic that declined to route.
    expect(plan('   ').signals).toEqual(['fallback:no-signal', 'short-prompt:0-tokens']);
  });

  it('measures a non-Latin prompt even though no word table can match it', () => {
    expect(plan(CYRILLIC_PROMPT).signals).toEqual(['long-prompt:15-tokens']);
  });

  it('always reports itself as the source', () => {
    expect(plan('anything').source).toBe('heuristic');
  });
});

describe('resolvePlanner', () => {
  it('returns the heuristic planner by default', () => {
    expect(resolvePlanner('heuristic').id).toBe('heuristic');
  });

  it('rejects an unknown planner by name', () => {
    expect(() => resolvePlanner('psychic')).toThrow(/unknown planner/i);
  });
});
