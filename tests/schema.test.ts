// The 2020-12 build: `ajv-instance.ts` routes a schema declaring no `$schema`
// there, and the fixture the compile-count spy below uses declares none, so
// spying on the draft-07 `Ajv.prototype` would not intercept it.
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it, vi } from 'vitest';

import {
  PERMISSIVE_SCHEMA,
  SchemaValidatorCache,
  ajvErrorsToText,
  compileSchema,
  validateArgs,
} from '../src/engine/schema.js';
import { captureStderr } from './helpers.js';

const nestedSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    address: {
      type: 'object',
      properties: { zip: { type: 'string' } },
      required: ['zip'],
    },
  },
  required: ['name'],
};

// ---------------------------------------------------------------------------
// Well-formed schema: accept/reject, required, type mismatch, nested error.
// ---------------------------------------------------------------------------

describe('compileSchema / validateArgs — well-formed schema', () => {
  it('accepts valid args', () => {
    const validate = compileSchema(nestedSchema);
    const result = validateArgs(validate, { name: 'a', address: { zip: '123' } });
    expect(result).toEqual({ valid: true });
  });

  it('rejects args missing a required property', () => {
    const validate = compileSchema(nestedSchema);
    const result = validateArgs(validate, {});
    expect(result.valid).toBe(false);
    if (result.valid) {
      expect.unreachable('expected validation to fail for a missing required property');
    }
    expect(result.errorText).toBe("(root) must have required property 'name'");
  });

  it('rejects a top-level type mismatch', () => {
    const validate = compileSchema(nestedSchema);
    const result = validateArgs(validate, { name: 5 });
    expect(result.valid).toBe(false);
    if (result.valid) {
      expect.unreachable('expected validation to fail for a wrong-typed property');
    }
    expect(result.errorText).toBe('/name must be string');
  });

  it('rejects a nested property type mismatch', () => {
    const validate = compileSchema(nestedSchema);
    const result = validateArgs(validate, { name: 'a', address: { zip: 5 } });
    expect(result.valid).toBe(false);
    if (result.valid) {
      expect.unreachable('expected validation to fail for a wrong-typed nested property');
    }
    expect(result.errorText).toBe('/address/zip must be string');
  });
});

// ---------------------------------------------------------------------------
// Error rendering — matches mcp-server/src/ajv.ts's instancePath/(root) shape.
// ---------------------------------------------------------------------------

describe('ajvErrorsToText', () => {
  it('renders a nested instancePath and message, joined by "; " for multiple errors', () => {
    const validate = compileSchema(nestedSchema);
    validate({ name: 5, address: { zip: 5 } });
    const text = ajvErrorsToText(validate.errors);
    expect(text).toBe('/name must be string; /address/zip must be string');
  });

  it('renders a root-level error (empty instancePath) as "(root)"', () => {
    const validate = compileSchema({ type: 'array' });
    validate({});
    const text = ajvErrorsToText(validate.errors);
    expect(text).toBe('(root) must be array');
  });

  it('renders "invalid input" for an empty or missing error list', () => {
    expect(ajvErrorsToText(null)).toBe('invalid input');
    expect(ajvErrorsToText(undefined)).toBe('invalid input');
    expect(ajvErrorsToText([])).toBe('invalid input');
  });
});

// ---------------------------------------------------------------------------
// Headline behavior: malformed schema warns and still allows the call.
// ---------------------------------------------------------------------------

describe('compileSchema — malformed schema', () => {
  it('warns on stderr and returns a permissive validator that allows the call', () => {
    // `properties` must be an object per JSON Schema; a string value makes
    // this schema fail to compile.
    const malformed = { properties: 'not-an-object' };

    let validate: ReturnType<typeof compileSchema> | undefined;
    const stderr = captureStderr(() => {
      validate = compileSchema(malformed);
    });

    expect(stderr).toContain('fezoctl:');
    expect(stderr).toContain('input_schema');
    if (!validate) {
      expect.unreachable('compileSchema must always return a validator, even on compile failure');
    }
    // The permissive fallback allows arbitrary args through — a backend's bad
    // schema must never make its own tool uncallable.
    const result = validateArgs(validate, { anything: 'goes', nested: { too: 1 } });
    expect(result).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// strict: false — backend schemas may use keys AJV's strict mode rejects.
// ---------------------------------------------------------------------------

describe('compileSchema — strict mode is disabled', () => {
  it('compiles a schema using a keyword AJV strict mode would reject, without warning', () => {
    // Under `strict: true`, AJV throws "strict mode: unknown keyword:
    // \"example\"" for this schema. Under this module's `strict: false`, it
    // must compile cleanly and validate normally.
    const schemaWithUnknownKeyword = {
      type: 'object',
      properties: { a: { type: 'string' } },
      example: { a: 'sample' },
    };

    let validate: ReturnType<typeof compileSchema> | undefined;
    const stderr = captureStderr(() => {
      validate = compileSchema(schemaWithUnknownKeyword);
    });

    expect(stderr).toBe('');
    if (!validate) {
      expect.unreachable('compileSchema must return a validator for this schema');
    }
    expect(validateArgs(validate, { a: 'ok' })).toEqual({ valid: true });
    expect(validateArgs(validate, { a: 5 }).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Boolean schemas (legal at HttpBodyMediaType.schema's top level).
// ---------------------------------------------------------------------------

describe('compileSchema — boolean media-type schemas', () => {
  it('a `true` schema accepts any value', () => {
    const validate = compileSchema(true);
    expect(validateArgs(validate, { anything: 1 })).toEqual({ valid: true });
    expect(validateArgs(validate, null)).toEqual({ valid: true });
    expect(validateArgs(validate, 'a string')).toEqual({ valid: true });
  });

  it('a `false` schema rejects any value', () => {
    const validate = compileSchema(false);
    expect(validateArgs(validate, { anything: 1 }).valid).toBe(false);
    expect(validateArgs(validate, null).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reuse: a candidate's schema is compiled once, not once per validate call.
// ---------------------------------------------------------------------------

describe('SchemaValidatorCache', () => {
  it('reuses a compiled validator across multiple validate calls without recompiling', () => {
    const compileSpy = vi.spyOn(Ajv2020.prototype, 'compile');
    try {
      const cache = new SchemaValidatorCache();
      const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };

      const first = cache.get(schema);
      const second = cache.get(schema);

      expect(second).toBe(first);
      expect(compileSpy).toHaveBeenCalledTimes(1);

      // The single compiled validator backs two independent validate calls.
      expect(validateArgs(first, { a: 'x' })).toEqual({ valid: true });
      expect(validateArgs(second, {}).valid).toBe(false);
      // Reuse did not trigger a second compilation.
      expect(compileSpy).toHaveBeenCalledTimes(1);
    } finally {
      compileSpy.mockRestore();
    }
  });

  // AJV already dedupes compilation of well-formed schemas by object identity
  // internally (see the first test above), so the cache's own non-redundant
  // value is suppressing repeat compile attempts -- and repeat warnings --
  // for a MALFORMED schema across retries of the same candidate. Without
  // this test, deleting the cache as "AJV already does this" would silently
  // reintroduce a stderr warning on every retry instead of once.
  it('warns exactly once for a malformed schema looked up twice (e.g. across a retry)', () => {
    const cache = new SchemaValidatorCache();
    const malformed = { properties: 'not-an-object' };

    let first: ReturnType<typeof cache.get> | undefined;
    let second: ReturnType<typeof cache.get> | undefined;
    const stderr = captureStderr(() => {
      first = cache.get(malformed);
      second = cache.get(malformed);
    });

    expect(second).toBe(first);
    const warningCount = (stderr.match(/fezoctl:/g) ?? []).length;
    expect(warningCount).toBe(1);
  });

  it('caches the two boolean schema slots independently of object schemas', () => {
    const cache = new SchemaValidatorCache();
    const trueValidator1 = cache.get(true);
    const trueValidator2 = cache.get(true);
    const falseValidator = cache.get(false);

    expect(trueValidator2).toBe(trueValidator1);
    expect(falseValidator).not.toBe(trueValidator1);
    expect(validateArgs(trueValidator1, 'anything')).toEqual({ valid: true });
    expect(validateArgs(falseValidator, 'anything').valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PERMISSIVE_SCHEMA sanity: it is itself a valid, permissive object schema.
// ---------------------------------------------------------------------------

describe('PERMISSIVE_SCHEMA', () => {
  it('compiles and accepts an object', () => {
    const validate = compileSchema(PERMISSIVE_SCHEMA);
    expect(validateArgs(validate, { a: 1 })).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// Edge-case schemas and inputs a backend's real (well-formed) manifest can
// legitimately produce, distinct from the malformed/permissive-fallback path
// above.
// ---------------------------------------------------------------------------

describe('compileSchema / validateArgs — an empty {} schema', () => {
  it('compiles cleanly (not via the malformed-schema fallback) and accepts any value, including non-objects', () => {
    // `{}` is a well-formed JSON Schema -- the schema with no constraints at
    // all -- distinct from PERMISSIVE_SCHEMA (`{type:'object'}`, which DOES
    // reject a non-object) and distinct from a schema that fails to compile.
    const stderr = captureStderr(() => {
      const validate = compileSchema({});
      expect(validateArgs(validate, { a: 1 })).toEqual({ valid: true });
      expect(validateArgs(validate, [1, 2, 3])).toEqual({ valid: true });
      expect(validateArgs(validate, 'a string')).toEqual({ valid: true });
      expect(validateArgs(validate, null)).toEqual({ valid: true });
    });
    // No compile-failure warning: {} is well-formed, so the permissive-fallback
    // path must not have been taken to reach this result.
    expect(stderr).toBe('');
  });
});

describe('compileSchema / validateArgs — a null argument against a real object schema', () => {
  it('rejects null: `type: "object"` does not accept it, and the missing-required-property message is not what fires', () => {
    const validate = compileSchema(nestedSchema);
    const result = validateArgs(validate, null);
    expect(result.valid).toBe(false);
    if (result.valid) {
      expect.unreachable('expected validation to fail for a null argument against an object schema');
    }
    expect(result.errorText).toBe('(root) must be object');
  });
});

// ---------------------------------------------------------------------------
// Declared `$schema` dialects.
//
// Regression guard. Every method in the live gateway catalog declares
// `"$schema": "https://json-schema.org/draft/2020-12/schema"`, and every
// fixture above declares no `$schema` at all -- so the whole suite passed
// while `compileSchema` was built on AJV's draft-07 entry point, where a
// 2020-12 declaration throws `no schema with key or ref "..."` and every
// catalog schema silently degraded to PERMISSIVE_SCHEMA. A fixture WITHOUT a
// `$schema` key cannot catch that; these declare one on purpose.
//
// Declaring a dialect is necessary but NOT sufficient. The shape below uses
// only `type`/`properties`/`required`, which mean the same thing in every
// draft, so it proves the `$schema` URI RESOLVES -- not that the instance reads
// that dialect's keywords. Dialect-specific syntax is covered separately after
// this loop; without those cases, routing every dialect to one build passes
// here.
// ---------------------------------------------------------------------------

const DIALECTS: ReadonlyArray<readonly [string, string]> = [
  ['2020-12', 'https://json-schema.org/draft/2020-12/schema'],
  ['2020-12 (trailing #)', 'https://json-schema.org/draft/2020-12/schema#'],
  ['2019-09', 'https://json-schema.org/draft/2019-09/schema'],
  ['draft-07', 'http://json-schema.org/draft-07/schema#'],
  ['draft-07 (no #)', 'http://json-schema.org/draft-07/schema'],
  ['draft-06', 'http://json-schema.org/draft-06/schema#'],
];

describe('compileSchema — schemas that declare a $schema dialect', () => {
  for (const [label, dialect] of DIALECTS) {
    it(`compiles a ${label} schema for real: no fallback warning, and constraints are enforced`, () => {
      const schema = {
        $schema: dialect,
        type: 'object',
        properties: { q: { type: 'string' }, count: { type: 'integer' } },
        required: ['q'],
      };

      const stderr = captureStderr(() => {
        const validate = compileSchema(schema);

        // The load-bearing assertion: a missing required property is caught
        // locally. Under PERMISSIVE_SCHEMA (`{type:'object'}`) this object is
        // valid, so this is exactly what the degradation let through.
        const missing = validateArgs(validate, { count: 2 });
        expect(missing.valid).toBe(false);
        if (missing.valid) expect.unreachable('expected the missing required property to be rejected');
        expect(missing.errorText).toBe("(root) must have required property 'q'");

        expect(validateArgs(validate, { q: 'zk rollups', count: 2 })).toEqual({ valid: true });
        expect(validateArgs(validate, { q: 42 }).valid).toBe(false);
      });

      // The permissive fallback announces itself on stderr. Silence here is
      // the proof that the real validator -- not the fallback -- ran above.
      expect(stderr).toBe('');
    });
  }

  // -------------------------------------------------------------------------
  // Dialect-specific syntax. These are the cases a shared-shape fixture cannot
  // reach: each uses a construct that is legal in ONE dialect and rejected by
  // the other's meta-schema, so it goes red if that dialect's schemas are
  // compiled on the wrong build.
  // -------------------------------------------------------------------------

  it('reads draft-07 tuple-form `items` as draft-07, not as 2020-12', () => {
    // 2020-12 renamed tuple-form `items` to `prefixItems` and its meta-schema
    // rejects an array here: on the 2020-12 build this schema throws `items
    // value must be ["object","boolean"]` and degrades to PERMISSIVE_SCHEMA.
    // Registering the draft-07 meta-schema on a 2020-12 instance does NOT fix
    // this -- that only makes the `$schema` URI resolvable, leaving keyword
    // semantics 2020-12's.
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } },
      required: ['pair'],
    };

    const stderr = captureStderr(() => {
      const validate = compileSchema(schema);
      expect(validateArgs(validate, { pair: ['a', 1] })).toEqual({ valid: true });

      // Position 0 must be a string. Under PERMISSIVE_SCHEMA this object is
      // valid, so this assertion is what the degradation let through.
      const wrong = validateArgs(validate, { pair: [1, 1] });
      expect(wrong.valid).toBe(false);
      if (wrong.valid) expect.unreachable('expected the tuple position type to be enforced');
    });
    expect(stderr).toBe('');
  });

  it('reads 2020-12 `prefixItems` as 2020-12, not as draft-07', () => {
    // The converse: `prefixItems` does not exist in draft-07, where the
    // constraint would simply be ignored and the wrong-typed element accepted.
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] } },
      required: ['pair'],
    };

    const stderr = captureStderr(() => {
      const validate = compileSchema(schema);
      expect(validateArgs(validate, { pair: ['a', 1] })).toEqual({ valid: true });
      expect(validateArgs(validate, { pair: [1, 1] }).valid).toBe(false);
    });
    expect(stderr).toBe('');
  });

  // -------------------------------------------------------------------------
  // Cache-order independence.
  //
  // `cli.ts` and `retry.ts` each construct their own SchemaValidatorCache over
  // the shared compiler. A failed compile still registers the schema on the AJV
  // instance as a side effect, so a second compile of the SAME object succeeded
  // where the first threw: the first cache to touch it got PERMISSIVE_SCHEMA,
  // the second got a real validator, and the same arguments then validated
  // differently depending on which layer looked first.
  //
  // This needs a schema that genuinely FAILS to compile -- a schema that
  // compiles cannot exhibit the divergence, so asserting on one proves nothing.
  // -------------------------------------------------------------------------

  it('gives two independent caches the same verdict for a schema that fails to compile', () => {
    // draft-04 is the honest example: AJV 8 dropped it (it needs the separate
    // ajv-draft-04 package), so no build here can compile this and both caches
    // must land on the permissive fallback.
    const schema = {
      $schema: 'http://json-schema.org/draft-04/schema#',
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    };
    const args = { count: 2 };

    let viaFirst: ReturnType<typeof validateArgs> | undefined;
    let viaSecond: ReturnType<typeof validateArgs> | undefined;
    const stderr = captureStderr(() => {
      viaFirst = validateArgs(new SchemaValidatorCache().get(schema), args);
      viaSecond = validateArgs(new SchemaValidatorCache().get(schema), args);
    });

    expect(viaFirst).toEqual(viaSecond);
    // Both took the permissive path, so both announced it. Before the fix the
    // second compile succeeded, so only ONE warning was emitted and the two
    // verdicts differed.
    expect(stderr.match(/using permissive validator/g)).toHaveLength(2);
  });

  it('gives two independent caches the same verdict for a malformed schema', () => {
    // The companion case, and NOT a witness to the bug above: `type: 'bogus'`
    // fails meta-schema validation, which runs before AJV caches the schema, so
    // this cause never diverged. It is pinned here because the two causes are
    // indistinguishable from a caller's side -- both surface as "compileSchema
    // fell back" -- and a future change to the fallback path must keep BOTH
    // order-independent, not just the one that was broken.
    const schema = { type: 'bogus' };
    const args = { anything: true };

    let viaFirst: ReturnType<typeof validateArgs> | undefined;
    let viaSecond: ReturnType<typeof validateArgs> | undefined;
    const stderr = captureStderr(() => {
      viaFirst = validateArgs(new SchemaValidatorCache().get(schema), args);
      viaSecond = validateArgs(new SchemaValidatorCache().get(schema), args);
    });

    expect(viaFirst).toEqual(viaSecond);
    expect(stderr.match(/using permissive validator/g)).toHaveLength(2);
  });
});
