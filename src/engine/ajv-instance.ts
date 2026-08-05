// The one place AJV instances are constructed.
//
// A schema's `$schema` keyword names the dialect its keywords are to be read
// in, and AJV implements one dialect per instance: `import { Ajv } from 'ajv'`
// is the *draft-07* build, `ajv/dist/2019.js` and `ajv/dist/2020.js` export the
// 2019-09 and 2020-12 builds. `addMetaSchema` only teaches an instance to
// *resolve* another dialect's `$schema` URI — it does not change how that
// instance reads keywords. So no single instance serves every dialect the
// catalog might publish, and picking one and hoping is not a neutral choice:
//
//   - Every method in the live gateway catalog declares
//     `"$schema": "https://json-schema.org/draft/2020-12/schema"`. On the
//     draft-07 build, compiling one throws
//     `no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`.
//   - A draft-07 schema may use tuple-form `items` (`"items": [{…}, {…}]`),
//     which 2020-12 renamed to `prefixItems` and whose meta-schema now rejects
//     as an array. On the 2020-12 build, compiling one throws
//     `items value must be ["object","boolean"]`.
//
// Either way `compileSchema` catches the throw and substitutes
// `PERMISSIVE_SCHEMA`, so the failure is not fatal — it is worse than fatal:
// argument validation silently degrades to "is it an object?" for that tool,
// and a caller's typo reaches the provider as a billed request instead of being
// rejected locally. `SchemaCompiler` therefore holds one instance per supported
// dialect and routes each schema to the build that reads it correctly, with the
// 2020-12 build serving a schema that declares no `$schema` at all.
//
// **A failed compile is unregistered.** A `compile()` that throws *after*
// caching the schema — an unresolvable `$schema` URI, as opposed to a schema the
// meta-schema rejects outright, which fails earlier — leaves it registered on
// the instance as a side effect, so a *second* `compile()` of the same schema
// object succeeds where the first threw.
// `schema.ts`'s validator caches and `cli.ts`'s compile probe look at the same
// schema objects independently, so a schema no build can compile (draft-04,
// which AJV 8 dropped, or a `$schema` URI none of them knows) used to yield the
// permissive fallback to whichever looked first and a real validator to the
// second — the same arguments validating differently depending on layer
// ordering. `compile()` unregisters a schema that failed, so every caller fails
// alike.

import { Ajv } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import draft06MetaSchema from 'ajv/dist/refs/json-schema-draft-06.json' with { type: 'json' };
import type { ValidateFunction } from 'ajv';

/**
 * The slice of an AJV instance this module uses. The three builds are siblings
 * over a shared core rather than subclasses of one another, so the routing
 * table is typed by what it calls rather than by a common base class.
 */
type DialectAjv = Pick<Ajv2020, 'compile' | 'removeSchema'>;

/**
 * `strict: false` because backend schemas carry keys AJV's strict mode
 * rejects; `allErrors: true` so a rejected argument object reports every
 * problem at once rather than one per round-trip.
 */
const OPTIONS = { allErrors: true, strict: false } as const;

/**
 * Normalizes a declared `$schema` URI to the form used as a routing key: the
 * canonical `https` spelling with no trailing `#`. The dialect URIs are
 * identifiers rather than fetched documents, so a backend spelling one
 * `http://…/schema#` names the same dialect as `https://…/schema` and must
 * route to the same build.
 */
function normalizeDialect(uri: string): string {
  return uri.replace(/^http:/, 'https:').replace(/#$/, '');
}

const DIALECT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const DIALECT_2019_09 = 'https://json-schema.org/draft/2019-09/schema';
const DIALECT_DRAFT_07 = 'https://json-schema.org/draft-07/schema';
const DIALECT_DRAFT_06 = 'https://json-schema.org/draft-06/schema';

/**
 * Reads the dialect a schema declares, normalized, or `undefined` when it
 * declares none (a bare boolean schema, or an object with no `$schema`).
 */
function declaredDialect(schema: object | boolean): string | undefined {
  if (typeof schema !== 'object') return undefined;
  const declared = (schema as { $schema?: unknown }).$schema;
  return typeof declared === 'string' ? normalizeDialect(declared) : undefined;
}

/**
 * Compiles catalog schemas, routing each to an AJV build that implements the
 * dialect it declares. See the file header for why one instance is not enough
 * and why a failed compile is unregistered.
 */
export class SchemaCompiler {
  private readonly draft2020 = new Ajv2020(OPTIONS);
  private readonly byDialect: ReadonlyMap<string, DialectAjv>;

  constructor() {
    // draft-06 rides on the draft-07 build: AJV 8 has no separate draft-06
    // build, and registering the older meta-schema on this one is the route
    // AJV documents for it. The two dialects' keywords agree everywhere the
    // catalog is likely to tread — notably tuple-form `items`, the construct
    // the 2020-12 build rejects.
    const draft07 = new Ajv(OPTIONS);
    draft07.addMetaSchema(draft06MetaSchema);

    this.byDialect = new Map<string, DialectAjv>([
      [DIALECT_2020_12, this.draft2020],
      [DIALECT_2019_09, new Ajv2019(OPTIONS)],
      [DIALECT_DRAFT_07, draft07],
      [DIALECT_DRAFT_06, draft07],
    ]);
  }

  /**
   * Compiles `schema` on the instance for its declared dialect, or on the
   * 2020-12 instance when it declares none or declares one no build implements
   * — the latter throws, which is the honest outcome and is now the outcome
   * every caller sees. Throws exactly what AJV throws; callers decide whether a
   * failure is fatal (`compileSchema` substitutes `PERMISSIVE_SCHEMA`).
   */
  compile(schema: object | boolean): ValidateFunction {
    const ajv = this.instanceFor(schema);
    try {
      return ajv.compile(schema);
    } catch (err) {
      ajv.removeSchema(schema);
      throw err;
    }
  }

  private instanceFor(schema: object | boolean): DialectAjv {
    const declared = declaredDialect(schema);
    if (declared === undefined) return this.draft2020;
    return this.byDialect.get(declared) ?? this.draft2020;
  }
}

/** Constructs a compiler over a fresh instance per supported dialect. */
export function newSchemaCompiler(): SchemaCompiler {
  return new SchemaCompiler();
}
