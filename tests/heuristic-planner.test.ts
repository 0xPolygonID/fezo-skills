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

// ---------------------------------------------------------------------------
// Final-review MAJ-4: a residual made only of connectives is not a query.
//
// Stripping the URLs out of a prompt leaves whatever prose surrounded them, and
// that remainder was emitted as a query whenever it had a search verb, a
// question word, or four tokens -- none of which requires the remainder to
// carry any SUBJECT. The cost is not the wasted fan-out. It is that the round
// then correctly diagnoses the junk result as a thin-coverage gap and offers a
// `--depth research` follow-up on the same meaningless string, turning two
// wasted calls into ten.
//
// The test is "does any token survive the stop-word, question-word and
// search-verb sets", so a residual with a real subject still becomes a query
// even when it reads awkwardly -- see the `is ... better` row below, which is
// deliberately NOT suppressed.
// ---------------------------------------------------------------------------

describe('heuristicPlanner: a residual with no content word is not a query', () => {
  const noQuery = [
    'compare https://a.example/x and https://b.example/y',
    'what https://example.com/a',
    'find https://a.example',
    'a the of and https://a.example',
    'search https://a.example please',
  ];

  it.each(noQuery)('emits no query for %s', (prompt) => {
    const p = heuristicPlanner.plan(prompt);
    expect(p.queries).toEqual([]);
    expect(p.intents).toContain('scrape');
  });

  it('records the decision as a signal, like every other decision it makes', () => {
    expect(heuristicPlanner.plan('compare https://a.example/x and https://b.example/y').signals)
      .toContain('residual-has-no-content');
  });

  it('still emits a query when the residual carries a real subject', () => {
    // 'say', 'about' and 'pricing' survive all three sets; the row at the top
    // of this file asserting this exact prompt must keep passing.
    expect(heuristicPlanner.plan('what does https://example.com say about pricing').queries)
      .toEqual(['what does say about pricing']);
  });

  it('does not suppress a residual that is merely terse', () => {
    // 'better' is a content word. Suppressing this would be the heuristic
    // deciding the query is bad rather than deciding it is empty, which is a
    // judgement it has no basis to make.
    expect(heuristicPlanner.plan('is https://a.example/x better').queries).toEqual(['is better']);
  });

  it('leaves a URL-free prompt alone', () => {
    expect(heuristicPlanner.plan('compare rust and go').queries).toEqual(['compare rust and go']);
  });
});

// ---------------------------------------------------------------------------
// The no-content guard applies to a LEFTOVER, never to a whole prompt.
//
// Gating it on `targets.length > 0` is the correctness of the guard, not a
// refinement of it: for a URL-free prompt the "residual" is everything the user
// typed, so suppressing it produces a plan with nothing to do -- and such a
// round exits 2 with an empty report and no gap, no next action, and no signal
// the research renderer prints. "the who" and "what is this" are ordinary
// searches, and they are made entirely of the words the guard tests against.
// ---------------------------------------------------------------------------

describe('heuristicPlanner: the no-content guard needs a URL to apply', () => {
  const urlFree = ['the who', 'what is this', 'who can do this', 'search for the page', 'list'];

  it.each(urlFree)('still searches for the URL-free prompt %s', (prompt) => {
    const p = heuristicPlanner.plan(prompt);
    expect(p.queries).toEqual([prompt]);
    expect(p.signals).not.toContain('residual-has-no-content');
  });

  it('still suppresses the same words once they are a leftover', () => {
    expect(heuristicPlanner.plan('what https://example.com/a').queries).toEqual([]);
  });
});
