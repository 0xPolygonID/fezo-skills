// The one place an AJV instance is constructed.
//
// Every catalog schema is compiled by an instance from `newAjv()`. Two things
// about that construction are load-bearing enough to be worth stating here
// rather than at each call site.
//
// **The 2020-12 entry point, not the default one.** `import { Ajv } from 'ajv'`
// is AJV's *draft-07* build: it knows the draft-07 meta-schema and nothing
// newer. Every method in the live gateway catalog declares
// `"$schema": "https://json-schema.org/draft/2020-12/schema"`, and compiling
// such a schema on the draft-07 build throws
// `no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`.
// `compileSchema` catches that and substitutes `PERMISSIVE_SCHEMA`, so the
// failure is not fatal — it is worse than fatal: argument validation silently
// degrades to "is it an object?" for every tool, and a caller's typo reaches
// the provider as a billed request instead of being rejected locally.
//
// **Draft-07 is registered anyway.** `Ajv2020` knows 2020-12 and *not*
// draft-07, so swapping the entry point alone would only invert the bug the
// day a backend publishes a draft-07 `input_schema`. Registering the older
// meta-schema explicitly means both drafts — and a schema declaring no
// `$schema` at all — compile on the same instance.
//
// There is a second, subtler reason this matters. A failed `compile()` still
// registers the schema on the instance as a side effect, so a *second*
// `compile()` of the same schema object succeeds where the first threw.
// `cli.ts` and `retry.ts` each hold their own `SchemaValidatorCache`, so under
// a meta-schema miss the first cache to touch a schema got the permissive
// fallback while the second got a real validator — the same arguments
// validated differently depending on which layer looked first. Keeping every
// meta-schema the catalog can legally reference registered up front is what
// stops that divergence at the source.

import { Ajv2020 } from 'ajv/dist/2020.js';
import draft07MetaSchema from 'ajv/dist/refs/json-schema-draft-07.json' with { type: 'json' };

/**
 * Constructs an AJV instance configured for catalog schemas.
 *
 * `strict: false` because backend schemas carry keys AJV's strict mode
 * rejects; `allErrors: true` so a rejected argument object reports every
 * problem at once rather than one per round-trip.
 */
export function newAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addMetaSchema(draft07MetaSchema);
  return ajv;
}
