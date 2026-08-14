// The default planner: a deterministic, network-free, credential-free reading
// of one prompt string.
//
// WHAT THIS IS NOT: comprehension. It cannot decompose a research question into
// sub-queries, resolve "their pricing page" against a previous conversational
// turn, or know that "papers citing Vaswani et al." means an academic corpus.
// Those need the conversation and a model, and the caller -- an agent -- has
// both. This module's job is to be a DETERMINISTIC FLOOR: guarantee that a
// headless `fezoctl research "..."` does something sane, and make every
// decision it did make visible in `signals` so a better-informed caller knows
// exactly what to override.

import type { Intent } from '../intent.js';
import { STOP_WORDS } from '../rank.js';
import { DEPTH_FANOUT } from '../plan.js';
import type { PlanDepth, Planner, RoutingPlan } from '../plan.js';

/** Absolute URLs. Deliberately http(s)-only: a bare `example.com` is far more
 * often a topic than a fetch target, and guessing wrong spends a call on the
 * wrong intent.
 *
 * `)` is the one bracket that cannot be excluded from the character class.
 * Every other closer here (`>`, `"`, `'`, `]`) is vanishingly rare *inside* a
 * real address, so cutting the match at it is free; a closing paren is not --
 * Wikipedia and MSDN disambiguate with it
 * (`.../wiki/Merkle_tree_(data_structure)`), and those are among the commonest
 * addresses a research prompt pastes. Excluding it truncates such a URL into
 * one that does not resolve, which costs a billed fetch (see
 * TRAILING_PUNCTUATION). So `)` is admitted here and unwound afterwards by the
 * balanced-paren rule in `trimUrl`, which is the only way to tell a paren the
 * address owns from one the sentence wrapped around it. */
const URL_PATTERN = /https?:\/\/[^\s<>"'\]]+/g;

/** Punctuation a URL absorbs by standing at the end of a sentence or clause:
 * "see https://example.com/a." and "https://example.com/a, and also ..." both
 * put a character inside the match that the user never typed as part of the
 * address. Nothing downstream repairs this -- Task 10 hands `targets` to the
 * scrape provider verbatim -- so a stray period would spend a billed fetch on
 * a URL that does not exist and then report the miss as a coverage gap. */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

function countOf(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n += 1;
  return n;
}

/** Strip the characters a sentence, not an address, put at the end of a match.
 *
 * The paren rule is the standard one: a trailing `)` belongs to the sentence
 * only when the match holds more `)` than `(`, i.e. it closes something that
 * was opened outside the URL. That keeps `(https://example.com/a)` and
 * `[the docs](https://example.com/docs)` yielding the bare address while
 * leaving `.../Merkle_tree_(data_structure)` whole, which no fixed character
 * class can do -- the same character is part of the address in one prompt and
 * not in the other, and only the balance distinguishes them.
 *
 * Looped because the two strippers feed each other: "(see https://example.com/a.)"
 * ends in `)` (so TRAILING_PUNCTUATION does not fire) and, once that paren
 * goes, ends in `.`. One pass each would leave one of them behind. */
function trimUrl(match: string): string {
  let url = match;
  for (;;) {
    const stripped = url.replace(TRAILING_PUNCTUATION, '');
    if (stripped.endsWith(')') && countOf(stripped, ')') > countOf(stripped, '(')) {
      url = stripped.slice(0, -1);
      continue;
    }
    return stripped;
  }
}

/** Words that mean "recent", which is what distinguishes a `news` fan-out from
 * a plain `search` one. Matched as whole words, so every entry must be a single
 * token: membership is tested against `words()` output, which never contains a
 * space. Multi-word cues belong in RECENCY_PHRASES. */
const RECENCY_WORDS: ReadonlySet<string> = new Set([
  'latest', 'recent', 'current', 'currently', 'today', 'yesterday', 'now',
  'breaking', 'news', 'update', 'updates',
]);

/** Recency cues that span a word boundary, and so can only be found by scanning
 * the prompt text rather than its tokens. */
const RECENCY_PHRASES = ['this week', 'this month', 'this year'];
// Frozen because determinism is a property of the data, not just the code: a
// planner that could be re-tuned at runtime would stop being a floor.
Object.freeze(RECENCY_PHRASES);

/** The same table compiled with `\b` at both ends, which is what makes scanning
 * the text safe. A bare substring test has no boundary, so "this week" fires
 * inside "this weekend" and "this year" inside "this yearbook" -- adding a
 * `news` fan-out to a prompt with no time reference in it at all, which is a
 * lane the user never asked for. Interpolation is safe because the source table
 * is frozen at module scope and holds no regex metacharacter. */
const RECENCY_PHRASE_PATTERNS: readonly RegExp[] = Object.freeze(
  RECENCY_PHRASES.map((phrase) => new RegExp(`\\b${phrase}\\b`)),
);

/** Phrases that ask, unambiguously, for breadth. Matched as substrings, so
 * every entry must be long enough not to collide with ordinary prose -- bare
 * "literature" is not, which is why it appears here only in its two
 * breadth-carrying compounds. Getting this wrong is expensive in the one
 * direction that matters: research fans out to 8 lanes against shallow's 2. */
const RESEARCH_PHRASES = [
  'deep research', 'comprehensive', 'in depth', 'in-depth', 'thorough',
  'everything about', 'all sources', 'as much as possible', 'exhaustive',
  'literature review', 'literature survey', 'survey of', 'research on',
  'research about',
];
Object.freeze(RESEARCH_PHRASES);

/** Openers that mark a prompt as a question rather than a lookup. */
const QUESTION_WORDS: ReadonlySet<string> = new Set(['what', 'why', 'how', 'when', 'where', 'who', 'which', 'is', 'are', 'does', 'do', 'can', 'should']);

/** Verbs that ask for retrieval even without a question form. */
const SEARCH_VERBS: ReadonlySet<string> = new Set(['find', 'search', 'compare', 'list', 'research', 'investigate', 'analyse', 'analyze', 'gather']);

/** Unicode-aware on purpose. The word tables above are English-only, so a
 * Chinese or Russian prompt still lands on the fallback intent whatever we do
 * here -- but an ASCII-only split would tokenize it to `[]`, and `pickDepth`
 * reads `tokens.length` as its proxy for effort. Measuring the length correctly
 * is what keeps a long non-Latin research prompt off the shallow, width-2 path
 * it does not deserve. */
function words(prompt: string): string[] {
  return prompt.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
}

function looksLikeYear(word: string): boolean {
  return /^(19|20)\d{2}$/.test(word);
}

function pickDepth(prompt: string, tokens: readonly string[], signals: string[]): PlanDepth {
  const lower = prompt.toLowerCase();
  for (const phrase of RESEARCH_PHRASES) {
    if (lower.includes(phrase)) {
      signals.push(`research-phrase:${phrase}`);
      return 'research';
    }
  }
  // A long prompt, or one joining several clauses, is asking for more than a
  // lookup. A short one is not. This is a proxy for effort, and a weak one --
  // which is exactly why `signals` says so and `--depth` overrides it.
  if (tokens.length >= 12) {
    signals.push(`long-prompt:${String(tokens.length)}-tokens`);
    return 'standard';
  }
  if (tokens.length <= 4) {
    signals.push(`short-prompt:${String(tokens.length)}-tokens`);
    return 'shallow';
  }
  const isQuestion = tokens[0] !== undefined && QUESTION_WORDS.has(tokens[0]);
  if (isQuestion) {
    // Prefixed to stay distinct from the intent stage's `question-form`: both
    // stages read the same cue, and `signals` is rendered to a human as the
    // explanation of the routing, where the same entry twice reads as a bug.
    signals.push('depth:question-form');
    return 'standard';
  }
  signals.push('default-depth');
  return 'shallow';
}

export const heuristicPlanner: Planner = {
  id: 'heuristic',
  plan(prompt: string): RoutingPlan {
    const signals: string[] = [];
    const intents: Intent[] = [];

    const targets = [...prompt.matchAll(URL_PATTERN)].map((m) => trimUrl(m[0]));
    if (targets.length > 0) {
      intents.push('scrape');
      signals.push(`url-literal:${String(targets.length)}`);
    }

    // The prompt minus its URLs: what is left is what a search would be for.
    // Interior whitespace is collapsed as well as trimmed, because the hole a
    // cut URL leaves would otherwise travel into the provider's query argument
    // and, worse, make two logically identical queries survive `clampPlan`'s
    // dedupe as distinct strings.
    const residual = prompt.replace(URL_PATTERN, ' ').replace(/\s+/g, ' ').trim();
    const tokens = words(residual);
    const hasQuestion = tokens[0] !== undefined && QUESTION_WORDS.has(tokens[0]);
    const hasSearchVerb = tokens.some((t) => SEARCH_VERBS.has(t));
    // Residual prose alongside a URL still means a search: "what does <url> say
    // about X" wants both the page and the topic.
    const wantsSearch = targets.length === 0 || hasQuestion || hasSearchVerb || tokens.length >= 4;
    if (wantsSearch && tokens.length > 0) {
      intents.push('search');
      if (hasQuestion) signals.push('question-form');
      if (hasSearchVerb) signals.push('search-verb');
    }

    const lowerResidual = residual.toLowerCase();
    const hasRecency = tokens.some((t) => RECENCY_WORDS.has(t) || looksLikeYear(t))
      || RECENCY_PHRASE_PATTERNS.some((pattern) => pattern.test(lowerResidual));
    if (hasRecency && intents.includes('search')) {
      intents.push('news');
      signals.push('recency-cue');
    }

    // Fail safe rather than empty: a prompt that matched nothing at all is
    // still a search, because returning "no intent" would make the command do
    // nothing for input a human plainly meant as a query.
    //
    // An empty or whitespace-only prompt reaches here too, and leaves with
    // neither a query nor a target -- a plan `parsePlanJson` would reject
    // outright ("a plan needs at least one of them"), because such a round can
    // never do anything. That asymmetry is deliberate: an empty prompt is a
    // usage error, which Task 12's cli.ts must catch during argv parsing and
    // exit 1 for, BEFORE anything is billed. Throwing from here instead would
    // move that check behind a planner call and give the caller no way to ask
    // "what would you do with this?" without an exception, so the planner
    // stays total and reports the emptiness through `fallback:no-signal` and
    // `short-prompt:0-tokens` rather than refusing to answer.
    if (intents.length === 0) {
      intents.push('search');
      signals.push('fallback:no-signal');
    }

    const depth = pickDepth(residual, tokens, signals);
    // A residual with no CONTENT word is not a query, however it was reached.
    //
    // `wantsSearch` above is satisfied by a search verb, a question word, or
    // four tokens -- none of which requires the remainder to name a subject. So
    // "compare <url> and <url>" arrived here with a residual of "compare and"
    // and became a billed fan-out for a string that asks nothing.
    //
    // The wasted calls are not the real cost. The round then correctly
    // diagnoses the junk it gets back as a thin-coverage gap and offers a
    // `--depth research` follow-up on the SAME string -- eight more lanes --
    // and SKILL.md tells the agent to run what `next_actions` offers. Two
    // wasted calls become ten, and the gap, which is honest, points at a remedy
    // that cannot work.
    //
    // The test is emptiness, never quality: a residual keeps its query if any
    // token survives all three sets, so a terse "is ... better" still searches.
    // Deciding a query is BAD is a judgement this planner has no basis to make;
    // deciding it is EMPTY is arithmetic.
    const hasContentWord = tokens.some(
      (token) => !STOP_WORDS.has(token) && !QUESTION_WORDS.has(token) && !SEARCH_VERBS.has(token),
    );
    const queries = intents.includes('search') && residual !== '' && hasContentWord ? [residual] : [];
    if (!hasContentWord && tokens.length > 0) signals.push('residual-has-no-content');
    if (queries.length === 0 && targets.length > 0) signals.push('targets-only');
    // Stated plainly, because it is the single most important limitation of
    // this planner and the reason an agent should override it for research.
    if (depth === 'research' && queries.length <= 1) {
      signals.push('no-decomposition: heuristic cannot split this into sub-queries; supply --queries');
    }

    return { intents, queries, targets, depth, fanout: DEPTH_FANOUT[depth], signals, source: 'heuristic' };
  },
};

/** Planner lookup by name. The LLM planner, if it is ever built, is one more
 * case here and one more file -- nothing downstream changes. */
export function resolvePlanner(id: string): Planner {
  if (id === 'heuristic') return heuristicPlanner;
  throw new Error(`unknown planner "${id}"`);
}
