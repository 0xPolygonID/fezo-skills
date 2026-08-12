> **Provenance.** Copied verbatim from `zug/mcp-server/docs/providers-score.md`
> so that `src/engine/providers.ts`'s `RECOMMENDATION_SOURCE.doc` points at a
> file that actually exists in *this* repository. The relationship note
> immediately below is mcp-server's own — it says `src/providers.ts`, meaning
> **mcp-server's** module of that name, not this repo's
> `src/engine/providers.ts`. In fezo-skills, `src/engine/providers.ts` is the
> equivalent machine-readable conclusion of the research below: same
> `RECOMMENDATIONS` table, same picks and order, ported rather than
> re-derived (see that module's own doc comment). The one link below
> (`../../docs/plans/2026-08-05-mcp-provider-scoring.md`) is mcp-server's
> internal planning doc and does not resolve from this copy — it is left
> as-is because this file is a verbatim copy, not a rewrite.

> **Relationship to `src/providers.ts`.** This document is the research behind
> the MCP server's declared per-intent provider recommendations
> (`src/providers.ts`'s `RECOMMENDATIONS`). `providers.ts` encodes this
> document's **conclusions** — the § TL;DR, § Revised Best-Value Ranking, and
> § Recommendations picks and their order — not its arithmetic: there is no
> code here that computes a score or a sort key, and the weighted totals below
> are currently **unused at runtime**. The two are kept in sync **by hand**: a
> re-read of this document is expected to produce a manual edit to
> `RECOMMENDATIONS` and to `RECOMMENDATION_SOURCE.preparedAt`, not an automatic
> recomputation. The scoring rubric's arithmetic becomes load-bearing only if
> the declared order needs to be defended externally (Phase C in
> [`../../docs/plans/2026-08-05-mcp-provider-scoring.md`](../../docs/plans/2026-08-05-mcp-provider-scoring.md)) —
> until then, treat every number below as documentation, not as an input any
> code path reads.

# Comparative Rating of 12 Web Scraping, Crawling & AI-Search API Providers (2026)

**Version 2 — Developer Experience / Integration removed from the rubric.**

**Prepared August 5, 2026. All pricing checked late July–early August 2026 against official pages plus third-party trackers. Pricing changes frequently; treat sales-gated figures as indicative and re-verify before contracting.**

## TL;DR

- **These 12 providers are not substitutes** — they span four functional categories. Within each, our best-value picks are: **Scrapingdog** (managed scraping APIs), **Geonode** (proxy infrastructure), **You.com** (AI search/grounding), and **NewsAPI.ai** (news). The cheapest self-serve entry points are Scrapingdog ($40/mo) and Bright Data / Geonode pay-as-you-go.
- **Best overall value-for-money on the revised rubric: You.com** (90.0/100), ahead of **Bright Data** (87.7) and **Geonode** (81.1).
- **Avoid by default for cost reasons: the official X (Twitter) API** — at $0.005 per post read (≈$5/1,000) with a hard 2,000,000-read/month cap and a ~$42,000/mo enterprise wall above it, it is roughly 30–90× costlier than third-party alternatives and carries the heaviest terms-of-service and lock-in risk.

## Revised Scoring Methodology

Developer experience / integration has been dropped. Its 15% weight is redistributed **proportionally** across the five remaining criteria, so their relative importance to one another is unchanged (each is multiplied by 100/85 ≈ 1.176 and rounded to whole numbers).

| Criterion | Old weight | **New weight** | What it measures |
| --- | --- | --- | --- |
| Price / cost-efficiency | 30% | **35%** | Effective $/1k requests or $/GB at low and high volume, including hidden multipliers **and billing predictability** |
| Capability breadth & depth | 25% | **30%** | Rendering, anti-bot, proxy pool, geotargeting, SERP, structured/LLM output, semantic search, news archive, crawling, batch/async, MCP |
| Reliability / performance | 15% | **17%** | Independently benchmarked success rate, latency, concurrency |
| Compliance / data-rights risk | 10% | **12%** | GDPR/CCPA posture, content licensing, TOS restrictions, lock-in |
| Business value / ROI | 5% | **6%** | Fit-to-job value beyond raw price |
| ~~Developer experience / integration~~ | ~~15%~~ | **removed** | ~~Self-serve signup, docs, SDKs, MCP, billing predictability~~ |

**One adjustment carried over:** billing predictability was previously scored under DX. Rather than let it disappear, it now sits inside Price / cost-efficiency. This lowers **Apify** from 6 to 5 on price (its prepaid-usage + metered-CU model is the least predictable in the group). No other raw score moves — the criteria are otherwise independent.

**What removing DX changes, structurally:** the rubric now rewards raw cost-efficiency and infrastructure capability, and no longer credits polish. Providers whose main advantage was ergonomics (SDKs, docs, MCP-first design) lose ground; providers that are cheap and capable but rougher to work with gain. Concretely: **Geonode rises to 3rd** (price weight up, and it scored a 10 there), **Exa and Firecrawl each fall two-plus places** (both had DX 9 as one of their top scores), **Scrapingdog gains relative footing** (its "no SDKs" weakness no longer counts against it), and **ScrapingBee falls further** (DX 8 had been propping up weak reliability).

## Revised Scores — Full Table

| Provider | Price (35%) | Capability (30%) | Reliability (17%) | Compliance (12%) | Bus. value (6%) | **Total** | v1 | Δ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| You.com | 9 | 9 | 9 | 9 | 9 | **90.0** | 91 | −1.0 |
| Bright Data | 7 | 10 | 10 | 9 | 9 | **87.7** | 88 | −0.3 |
| Geonode | 10 | 7 | 7 | 7 | 8 | **81.1** | 82 | −0.9 |
| Brave Search | 8 | 8 | 8 | 9 | 7 | **80.6** | 80 | +0.6 |
| Scrapingdog | 9 | 8 | 7 | 7 | 8 | **80.6** | 86 | −5.4 |
| Exa | 7 | 9 | 8 | 8 | 8 | **79.5** | 84 | −4.5 |
| NewsAPI.ai | 7 | 9 | 8 | 8 | 8 | **79.5** | 79 | +0.5 |
| Firecrawl | 7 | 9 | 7 | 8 | 8 | **77.8** | 82 | −4.2 |
| Apify | 5 | 9 | 8 | 8 | 7 | **71.9** | 78 | −6.1 |
| ScraperAPI | 7 | 7 | 7 | 7 | 7 | **70.0** | 72 | −2.0 |
| ScrapingBee | 6 | 7 | 5 | 7 | 6 | **62.5** | 70 | −7.5 |
| X API (read-only) | 2 | 7 | 8 | 4 | 3 | **48.2** | 42 | +6.2 |

Note that most totals drift downward simply because DX was, on average, the criterion on which these providers scored best — this is a mature, well-documented product category. The **ranking changes** matter more than the absolute deltas.

## Revised Best-Value Ranking

1. **You.com (90.0)** — cheapest quality AI search, generous free credits, clean data rights.
2. **Bright Data (87.7)** — unmatched success rate and breadth; premium but earns it. Barely moves, because its strength was never ergonomics.
3. **Geonode (81.1)** — biggest gainer in rank. Pure cost-efficiency now carries more weight.
4. **Brave Search (80.6)** / **Scrapingdog (80.6)** — tied.
5. **Exa (79.5)** / **NewsAPI.ai (79.5)** — tied; Exa's fall is entirely the loss of DX credit.
6. **Firecrawl (77.8)** — the most DX-dependent product in the set.
7. **Apify (71.9)** — billing predictability now counts against it directly.
8. **ScraperAPI (70.0)**
9. **ScrapingBee (62.5)**
10. **X API (48.2)** — rises on paper only because it lost a middling DX score while reliability weight went up. Still last by a wide margin, and still not recommended.

## Details by Provider

### AI / LLM Search & Grounding

**You.com API — Overall 90.0/100. Best value in category and overall.**

- **Pricing:** Web Search API **$5.00 per 1,000 calls** (livecrawl content bundled), Contents API $1/1k pages, Research API tiered by "effort" — $6.50/1k (lite), $50/1k (standard), $100/1k (deep), $300/1k (exhaustive); Finance Research $110/1k (deep). Pay-as-you-go, no minimum. **$100 free credits** on signup (verified you.com/docs). Search API price was cut to $5/1k effective March 12, 2026.
- **Capabilities:** multi-engine coverage including Google verticals (Scholar, Patents, Finance), freshness filtering (day/week/month/year/custom), country geotargeting, `site:` and exclusion operators, LLM-ready markdown, agentic multi-step Research API, News Search. You.com reports 91.1% accuracy on SimpleQA and is the only search-API provider with peer-reviewed evaluation research, earning an AAAI 2026 Best Paper Award. Queries/data can be auto-purged; infrastructure independently audited.
- **Limitations:** the earlier consumer chat product has mixed review scores; higher research tiers get expensive fast; no permanent free tier (one-time credits only).
- **Scores:** Price 9, Capability 9, Reliability 9, Compliance 9, Business value 9 → **90.0**

**Brave Search API — Overall 80.6/100.**

- **Pricing:** Web Search / LLM Context **$5 per 1,000 calls**; Base AI $5/1k (20 QPS, 20M queries/mo, AI-app rights); Pro AI $9/1k (50 QPS, unlimited); AI Grounding endpoint $4/1k web searches + $5/M tokens (input+output). **Free tier removed for new users in Feb 2026** — new signups now get $5 monthly credits (~1,000 queries); existing free-plan users grandfathered (up to 2,000/mo).
- **Capabilities:** independent 30B+ page index (not a Google/Bing reseller — clean data-sovereignty story), official MCP server, structured data (infoboxes, FAQs, news, forum/Reddit discussions), configurable freshness (24h/7d/30d), token-efficient LLM Context under ~600ms.
- **Limitations:** free-tier removal drew developer backlash; Answers/Grounding capped at ~2 QPS by default; more long-tail blind spots than Google; cannot access anti-bot-protected pages.
- **Scores:** Price 8, Capability 8, Reliability 8, Compliance 9, Business value 7 → **80.6**

**Exa (exa.ai) — Overall 79.5/100.** *(v1: 84 — the single largest DX-driven drop among the search APIs.)*

- **Pricing:** Search **$7/1k** (up to 10 results, page contents for first 10 bundled since March 2026), Answer $5/1k, Deep Search $12/1k, Deep-Reasoning $15/1k, Contents $1/1k pages, Monitors $15/1k, Agent $0.012–$1.00/run (or metered ACUs at $0.10 + $0.005/search). Additional results above 10 bill $1/1k each. **$20 signup credits + $10/month recurring free credits.** $1,000 startup/education grants. Enterprise custom.
- **Capabilities:** neural/embeddings semantic search, "Exa Instant" sub-150ms mode (launched Feb 2026), deep research, Websets structured data collection, code search, monitors with webhooks, MCP server. SOC 2 Type II; Zero Data Retention on enterprise.
- **Limitations:** content types stack (text + highlights + summaries = 3 line items per page); Agent auto-effort billing unpredictable; pricier than You.com/Brave for plain search.
- **Scores:** Price 7, Capability 9, Reliability 8, Compliance 8, Business value 8 → **79.5**

### Web Extraction / Scraping APIs

**Scrapingdog — Overall 80.6/100. Still the best-value scraping API.**

- **Pricing:** Lite **$40/mo** (200,000 credits, 5 concurrency), Standard ~$90, Pro, Premium $350/mo (6M credits, 150 concurrency), scaling up to $8,000/mo (220M credits, 700 concurrency). Annual saves ~17%; 10% promo (WELCOME2026) through 2026. Pay-as-you-go credits (don't expire) added late 2025. 30-day free trial, 1,000 credits, no card.
- **Credit multipliers:** basic 1 credit, JS rendering 5, premium proxies 10, JS+premium 25 (dedicated APIs like Google 5).
- **Capabilities:** headless rendering, anti-bot bypass, CAPTCHA solving, geotargeting on all plans, dedicated APIs for Google, Amazon, LinkedIn, Twitter, YouTube, Bing, Indeed. No charge for blocked requests.
- **Reliability:** Scrapeway July 2026 benchmark 50% success across 12 targets (#5 of 8), 6.2s avg, $2.7/1k. Fast on Google SERP (1.83s avg).
- **Limitations:** no integration SDKs and a basic web UI — **previously penalized under DX, now uncounted**; some targets need dedicated-API config; credits don't roll over.
- **Scores:** Price 9, Capability 8, Reliability 7, Compliance 7, Business value 8 → **80.6**

**Firecrawl — Overall 77.8/100.** *(v1: 82 — its AI-native ergonomics were its strongest asset and no longer score.)*

- **Pricing:** Free 1,000 credits/mo (no card), Hobby $16/mo (5,000 credits), Standard $83/mo (100,000; ~$0.00083/page), Growth $333/mo (500,000; ~$0.00066/page), Scale $599/mo (1,000,000; ~$0.0006/page), Enterprise custom. Annual saves ~15–22%. Credit-based, subscription only (no PAYG); credits don't roll over on standard plans.
- **Credit multipliers:** Scrape/Crawl/Map/Monitor 1 credit/page, Search 2/10 results, Interact 2/browser-min, **Stealth Mode 5×**, JSON extraction +4, Enhanced +4. Agent/Extract carries a separate token-based billing layer; a single agent query has been observed consuming 100–1,500+ credits; failed runs still bill.
- **Capabilities:** LLM-ready markdown/JSON by default, JS rendering, anti-bot, crawl/map/search/interact/parse endpoints, official MCP server (12 tools), open-source self-host option, SDKs, batch/async, webhooks; respects robots.txt.
- **Reliability:** Scrapeway 69% success across 12 targets.
- **Scores:** Price 7, Capability 9, Reliability 7, Compliance 8, Business value 8 → **77.8**

**Apify — Overall 71.9/100. Largest total drop (−6.1).**

- **Pricing:** Free ($5 monthly platform credit, no card), Starter $29/mo, Scale $199/mo, Business $999/mo, Enterprise custom. Annual saves 10%. Prepaid-usage model: the plan fee is a usage budget. Compute units metered (1 CU ≈ 1 GB-hour): ~$0.30/CU Free/Starter, $0.25 Scale, $0.20 Business. Proxies and storage bill separately; Store Actors add per-result/per-event fees. Concurrency 32→256 by tier. Rental Actors being phased out to pay-per-usage by October 2026.
- **Capabilities:** full scraping+automation platform, Actor marketplace (largest prebuilt-scraper ecosystem), datasets, schedulers, webhooks, proxies, storage, API/SDK, MCP.
- **Limitations:** the least predictable billing of the group; easy to overspend on headless/retry-heavy jobs; monthly credits expire. **Price score lowered 6 → 5** now that billing predictability is scored here rather than under DX.
- **Scores:** Price 5, Capability 9, Reliability 8, Compliance 8, Business value 7 → **71.9**

**ScraperAPI — Overall 70.0/100.**

- **Pricing:** Free 1,000 credits/mo (5 concurrency), Hobby $49/mo (100,000 credits, 20 threads; $44 annual), Startup $149/mo (1M), Business $299/mo (3M), Scaling $475/mo (5M), Enterprise custom. 7-day trial, 5,000 credits. Credits don't roll over; PAYG with spend caps on higher tiers.
- **Multipliers:** 1–75 credits per request; JS rendering 5–10, premium/ultra-premium proxies stack. Effective cost on hard targets can reach ~$36.75/1k pages.
- **Capabilities:** 40M+ IP pool, proxy rotation, JS rendering, CAPTCHA, 50+ geolocations (US/EU only on entry plans), structured JSON for Amazon/Google/Walmart, autoparse, async, DataPipeline scheduler.
- **Reliability:** Scrapeway July 2026 62% success (#4 of 8), 4.9s, $3.24/1k; 0% on social (Instagram/X).
- **Scores:** Price 7, Capability 7, Reliability 7, Compliance 7, Business value 7 → **70.0**

**ScrapingBee — Overall 62.5/100. Falls furthest (−7.5); DX had been masking weak reliability.**

- **Pricing:** Free trial 1,000 credits (no card), Freelance $49/mo (150K–250K credits, sources vary; 5 concurrency), Startup $99/mo (1M), Business $249/mo (3M), Business+ $599/mo (8M). Acquired by Oxylabs January 2026.
- **Multipliers:** JS rendering 5, premium proxies 25, **stealth 75 credits** — effective ~$14.70/1k pages on hard targets.
- **Capabilities:** JS rendering, proxy rotation, CAPTCHA, screenshots, AI Query extraction, request builder, dedicated SERP endpoint.
- **Reliability:** Scrapeway 2026 benchmarks near the bottom of tested APIs, ~31% overall success (0% on LinkedIn/Walmart/X/StockX/Zillow/realtor), 2.7–2.8s.
- **Scores:** Price 6, Capability 7, Reliability 5, Compliance 7, Business value 6 → **62.5**

### Proxy Infrastructure

**Geonode — Overall 81.1/100. Rises to 3rd overall. Best value proxy.**

- **Pricing:** owned-network residential from **$0.27/GB** (lowest-price-guaranteed floor), datacenter $0.59/GB (shared), rotating datacenter PAYG $0.60/GB, ISP/static residential ~$1.30–1.50/IP, Unlimited Residential priced by throughput (Mbps, no GB cap). Scraper API flat $0.13/1k requests (crawl $1.20/1k, search $1.50/1k) — no multipliers. $5/10GB 3-day trial (renews at $50/mo Starter). Free 1,500 API requests/mo. Bandwidth rolls over indefinitely while subscribed.
- **Capabilities:** residential/datacenter/ISP over HTTP/HTTPS/SOCKS5, 195+ countries, ASN/ISP targeting, sticky sessions, MCP. Own-supply cost basis (no upstream middleman) explains the price floor.
- **Limitations:** no mobile proxies; smaller pool than Bright Data/Oxylabs; no enterprise account-management layer; no prebuilt scraper marketplace.
- **Scores:** Price 10, Capability 7, Reliability 7, Compliance 7, Business value 8 → **81.1**

**Bright Data — Overall 87.7/100. Nearly unchanged (−0.3). Best for enterprise / hard targets.**

- **Pricing (verified July 2026):** Web Unlocker/SERP/Web Scraper API share a Free (5,000 results/mo) / PAYG ($1.5/1k) / Scale ($499/mo, ~380k included, $1.3/1k overage) / Enterprise ladder. Residential $2.50/GB promo (normally ~$5–8.40/GB PAYG, ~$3/GB committed). Datacenter $0.90/IP, ISP $1.30/IP. Browser API $5–8/GB. Datasets $2.50/1k records ($250/100k). Managed data acquisition ~$1,500/mo. Web Unlocker/SERP prices were cut 50% in early 2025.
- **Capabilities:** largest network, Web Unlocker (Cloudflare/DataDome bypass), SERP API (7 engines, 195 countries, thousands of cities), Web Scraper API, Crawl API, Browser API, prebuilt datasets, MCP, no concurrency limit. Per its own blog citing Scrape.do's independent 11-provider benchmark, Bright Data achieved a 98.44% average success rate — the highest in that test, with no other listed tool publishing an audited equivalent (note: the write-up is on Bright Data's own site). Holds GDPR, SOC 2/3, ISO 27701; sensitive products are KYC-gated.
- **Limitations:** premium pricing; complex product sprawl; mobile-proxy pricing gated behind KYC; some sales-gated tiers.
- **Scores:** Price 7, Capability 10, Reliability 10, Compliance 9, Business value 9 → **87.7**

### Specialized Data Sources

**NewsAPI.ai (Event Registry) — Overall 79.5/100. Best for news monitoring.**

- **Pricing:** Free 2,000 tokens. **5K plan $90/mo** (5,000 tokens, official). **10K plan ~$150/mo** (10,000 tokens — from a G2 customer review; the official FAQ confirms only the token count). Higher tiers not publicly priced (interactive slider / sales-gated). Overage confirmed verbatim on the official plans page: "each token above the plan limit will be charged on top of the plan. The cost of each extra token is 0.015$." Tokens don't roll over. Token cost scales with depth: recent article search 1 token, searching 2017 archive 5 tokens, 2015–2017 range 15 tokens; events 5 (recent) to 20 tokens/year (archive).
- **Capabilities:** enriched news intelligence — 60+ languages, archive back to 2014, entity recognition, 5,000+ topic categories, sentiment, duplicate detection, publisher rankings, event clustering. REST + Python/Node SDKs. Clients include Spotify, Bloomberg, IBM, and Accenture. (Publisher-count claims conflict on the vendor's own site — marketing pages say 150,000+ publishers, while the API documentation currently says "over 30,000 news publishers"; verify the exact figure for your use case.)
- **Limitations:** archive/historical queries multiply token cost sharply; higher-tier pricing opaque; academic discounts only.
- **Scores:** Price 7, Capability 9, Reliability 8, Compliance 8, Business value 8 → **79.5**

**X (Twitter) API — Overall 48.2/100. Still last, by a wide margin.**

- **Pricing (Feb 2026 shift to pay-per-use, restructured April 20, 2026):** $0.005/post read (~$5/1k), $0.001–$0.010/user (owned) read, with pay-per-usage capped at **2,000,000 post reads per monthly billing cycle** per X's official docs; above the cap, only Enterprise (~$42,000+/mo). Legacy Basic ($200/mo) and Pro ($5,000/mo, 1M reads, full-archive) are closed to new signups; remaining Basic subscribers force-migrated to PAYG after June 1, 2026. No free tier.
- **Capabilities:** authoritative first-party X data; full-archive search and streaming only on Enterprise/Pro.
- **Limitations:** restrictive TOS (data-retention limits, no "replicating core functionality," friction on competitor analysis), severe lock-in, hard read cap. Third parties undercut it massively — TwitterAPI.io charges $0.00015/read (~$0.15/1,000 tweets, no minimum, no cap) and Apify ~$0.40/1k tweets, i.e. roughly 30–90× cheaper. Only justifiable when first-party authenticity/compliance is mandatory.
- **Scores:** Price 2, Capability 7, Reliability 8, Compliance 4, Business value 3 → **48.2**
- **On the +6.2 gain:** this is a rubric artifact, not an improvement. X lost a middling DX score (6) while the reliability weight it scores well on (8) increased. Its disqualifying problems — price and TOS/lock-in risk — are unchanged.

## Comparison Table — Pricing at a Glance

| Provider | Category | Entry / cheapest paid | Effective low-volume | High-volume | Free tier | Self-serve? |
| --- | --- | --- | --- | --- | --- | --- |
| You.com | AI search | PAYG | $5/1k search | $5/1k | $100 credits | Yes |
| Exa | AI search | PAYG | $7/1k search | $7/1k+ | $20 + $10/mo | Yes |
| Brave | AI search | $5/1k | $5/1k | $5–9/1k | $5 credits/mo | Yes |
| Scrapingdog | Scraping | $40/mo | ~$0.20–2.7/1k | ~$0.06/1k | 1,000 credits | Yes |
| Firecrawl | Scraping | $16/mo | ~$3.20/1k (Hobby) | ~$0.60/1k | 1,000/mo | Yes |
| Apify | Scraping | $29/mo | ~$0.30/CU | ~$0.20/CU | $5/mo | Yes |
| ScraperAPI | Scraping | $49/mo | ~$0.49–36/1k | lower | 1,000/mo | Yes |
| ScrapingBee | Scraping | $49/mo | up to $14.70/1k | lower | 1,000 trial | Yes |
| Geonode | Proxy | PAYG / $50 | $0.27–0.59/GB | $0.27/GB | 1,500 req + $5/10GB | Yes |
| Bright Data | Proxy+scrape | PAYG / $499 | $1.5/1k, $2.50/GB | $1.3/1k, $3/GB | 5,000 results | Mostly (KYC) |
| NewsAPI.ai | News | $90/mo | ~$0.018/token | ~$0.015/token | 2,000 tokens | Partly |
| X API | Social | PAYG | $5/1k reads | $42k+/mo wall | None | PAYG / sales |

## Cheapest Ranking (self-serve, at meaningful volume) — unchanged

1. **Geonode** — $0.27/GB residential floor; $0.13/1k Scraper API.
2. **Scrapingdog** — ~$0.06/1k at scale on basic requests.
3. **Bright Data** — $1.3–1.5/1k API; committed residential ~$3/GB.
4. **Firecrawl** — $0.0006–0.00083/page at Scale/Standard.
5. **You.com / Brave** — $5/1k AI search (tied on headline rate; You.com bundles livecrawl content).

## Recommendations

The removal of DX shifts two of these, both toward cheaper/rawer options:

- **Low-budget indie / solo developer:** **Scrapingdog** ($40/mo, dedicated APIs) for scraping; **You.com** or **Brave** free credits for search; **Firecrawl** free tier (1,000/mo) for AI-ready extraction. *Caveat: if you are a solo developer, DX is arguably the criterion you can least afford to ignore — Firecrawl's ergonomics have real value to a one-person team even though this rubric no longer credits them. Test on your actual targets first to avoid credit-multiplier surprises.*
- **Mid-size startup, moderate volume (~10k–50k req/mo):** **Geonode** + a thin scraping layer now scores better than **Firecrawl Standard** ($83/mo) on pure price/capability, though Firecrawl remains the faster path to production. Use **You.com** for grounding. **Apify Scale** ($199/mo) drops down the list — its billing unpredictability is now priced in directly.
- **High-volume enterprise scraping (~1M+ req/mo):** **Bright Data** — unchanged recommendation, and the one least affected by this rubric revision. Highest benchmarked success (98.44%), full anti-bot stack, compliance certifications. Pair with **Geonode** as a lower-cost proxy for lightly-defended targets.
- **AI agent / RAG grounding:** **You.com** primary; **Exa** where semantic/neural retrieval quality matters most (its score drop reflects lost DX credit, not degraded search quality); **Brave** where an independent index and data sovereignty are priorities.
- **News monitoring:** **NewsAPI.ai** for enriched entity/sentiment/event intelligence and archive depth; budget for token multipliers on historical queries.
- **Social (X) data:** Use the official X API only when first-party authenticity/compliance is mandatory; otherwise the economics strongly favor third-party alternatives.

**Thresholds that change these calls:** If Scrapingdog's success rate on your specific targets drops below ~50%, switch to Bright Data. If AI-search volume exceeds ~2–3M calls/month, negotiate an enterprise deal or self-host an index. If proxy bandwidth exceeds ~1TB/month, Geonode's Unlimited (Mbps) plan or a Bright Data commit beats PAYG. If your scraping mix is >50% stealth/premium-proxy pages, credit-multiplier APIs (ScrapingBee, ScraperAPI, Firecrawl Stealth) lose to flat per-request models (Geonode, Bright Data).

## Caveats

- **Sales-gated / unverifiable pricing:** NewsAPI.ai tiers above 10K tokens, Bright Data mobile proxies (KYC), X API Enterprise, and all "Enterprise custom" tiers were not independently verifiable. The NewsAPI.ai 10K = $150/mo figure comes from a single third-party (G2) review, not the official rate card; the 5K = $90/mo figure is official.
- **Recently changed pricing:** Brave removed its free tier (Feb 2026); You.com cut Search to $5/1k (March 12, 2026); Exa bundled first-10-result contents (March 2026); X moved to pay-per-use (Feb 2026, restructured April 20, migrations from June 1, 2026); Bright Data cut Unlocker/SERP 50% (early 2025); ScrapingBee was acquired by Oxylabs (Jan 2026).
- **Benchmark volatility:** Scrapeway / Scrape.do / Proxyway success rates vary by target panel and date, and results are bimodal (high on easy sites, low on aggressively defended ones). Bright Data's 98.44% figure is reported on its own blog citing Scrape.do; treat vendor-hosted benchmarks with appropriate skepticism and run your own proof-of-concept.
- **Effective price depends on multipliers:** headline credit counts overstate real capacity wherever JS rendering, stealth mode, premium/residential proxies, or structured extraction apply. Always model your actual feature mix rather than the sticker credit allotment.
- **Data conflict noted:** NewsAPI.ai's marketing pages cite 150,000+ publishers while its API documentation currently says "over 30,000 publishers" — confirm the figure relevant to your coverage needs directly with the vendor.
- **On dropping DX:** the criterion is gone from the arithmetic but not from reality. Integration cost is real engineering time, and it falls hardest on small teams. If you are choosing between Firecrawl (77.8) and Scrapingdog (80.6), that 2.8-point gap is smaller than the difference in days-to-first-working-pipeline.
