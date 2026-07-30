import { Ajv } from 'ajv';
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
    const compileSpy = vi.spyOn(Ajv.prototype, 'compile');
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
