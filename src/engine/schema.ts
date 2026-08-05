// JSON Schema validation: compiles a backend's `input_schema` (and, where a
// body binding carries one, an `HttpBodyMediaType.schema`) into a reusable
// AJV validator and renders its errors for display.
//
// This module deliberately mirrors the reference MCP server's own AJV setup
// rather than inventing new behavior: a permissive fallback on compile
// failure, because a backend publishing a malformed schema must never make
// its own tool uncallable. How the AJV instance itself is configured — and
// why the choice of entry point is load-bearing — lives in
// `ajv-instance.ts`. Task 8 decides
// *where* validation runs (before `bindArgs`, alongside it, or not at all for
// a given call path); this module only compiles schemas and reports results.

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

import { newAjv } from './ajv-instance.js';

// ---------------------------------------------------------------------------
// Compilation.
// ---------------------------------------------------------------------------

/**
 * Schema used in place of a backend's `input_schema` (or body media-type
 * schema) when that schema fails to compile: accepts any object, so
 * discovery and calling continue rather than treating a malformed manifest as
 * fatal.
 */
export const PERMISSIVE_SCHEMA: object = { type: 'object' };

const ajv: Ajv2020 = newAjv();

/**
 * Emits a diagnostic to stderr, matching the convention every other engine
 * module uses (catalog.ts, bindings.ts): stdout is reserved for the CLI's
 * machine-readable output, so a silent degradation is announced here instead.
 */
function warn(message: string): void {
  process.stderr.write(`fezoctl: ${message}\n`);
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Compiles a (backend-supplied, possibly malformed) JSON Schema into an AJV
 * validator. `schema` accepts a top-level boolean because JSON Schema 2020-12
 * allows one in any schema position — `true` accepts every instance, `false`
 * rejects every instance — which is exactly the shape
 * `HttpBodyMediaType.schema` (catalog.ts) can carry. (`ToolCandidate.inputSchema`
 * is typed `object`, so it never arrives here as a bare boolean; that
 * normalization is catalog.ts's concern, not this function's.)
 *
 * On compile failure, warns on stderr and returns a validator compiled from
 * `PERMISSIVE_SCHEMA` instead, so one backend's bad schema cannot make its own
 * tool uncallable — matching the reference MCP server's behavior.
 */
export function compileSchema(schema: object | boolean): ValidateFunction {
  try {
    return ajv.compile(schema);
  } catch (err) {
    warn(`failed to compile input_schema; using permissive validator (${errorDetail(err)})`);
    return ajv.compile(PERMISSIVE_SCHEMA);
  }
}

/**
 * Renders AJV errors as a short human-readable string for tool error
 * messages. Matches mcp-server/src/ajv.ts's `ajvErrorsToText` shape exactly —
 * Task 8 renders this text to users — including its root-level fallback:
 * `instancePath` is `''` for a root-level error (e.g. the whole payload has
 * the wrong type), rendered as `(root)`.
 */
export function ajvErrorsToText(errors: ValidateFunction['errors']): string {
  if (!errors || errors.length === 0) return 'invalid input';
  return errors.map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
}

// ---------------------------------------------------------------------------
// Reuse across multiple calls/candidates.
// ---------------------------------------------------------------------------

/**
 * Caches compiled validators by schema identity, so a candidate's
 * `input_schema` (or a body media-type schema) is compiled once no matter how
 * many times `run` attempts that candidate — compilation is not free, and a
 * single call may validate the same schema repeatedly (e.g. a retry).
 *
 * Object schemas are cached by reference in a `WeakMap`: the catalog
 * normalizes each candidate once, so the same `inputSchema` object is passed
 * on every call for that candidate. Boolean schemas (`true`/`false`) cannot be
 * `WeakMap` keys and are cached in their own two slots instead.
 */
export class SchemaValidatorCache {
  private readonly byObject = new WeakMap<object, ValidateFunction>();
  private trueValidator: ValidateFunction | undefined;
  private falseValidator: ValidateFunction | undefined;

  /** Returns the cached validator for `schema`, compiling it on first use. */
  get(schema: object | boolean): ValidateFunction {
    if (schema === true) {
      const existing = this.trueValidator;
      if (existing) return existing;
      const compiled = compileSchema(true);
      this.trueValidator = compiled;
      return compiled;
    }
    if (schema === false) {
      const existing = this.falseValidator;
      if (existing) return existing;
      const compiled = compileSchema(false);
      this.falseValidator = compiled;
      return compiled;
    }
    const cached = this.byObject.get(schema);
    if (cached) return cached;
    const compiled = compileSchema(schema);
    this.byObject.set(schema, compiled);
    return compiled;
  }
}

// ---------------------------------------------------------------------------
// Validation result.
// ---------------------------------------------------------------------------

/** The outcome of validating a value against a compiled validator. */
export type ValidationResult = { valid: true } | { valid: false; errorText: string };

/**
 * Runs `validateFn` against `value` and reports the outcome, rendering any
 * errors with `ajvErrorsToText`. Does not compile or cache anything itself —
 * callers get a `ValidateFunction` from `compileSchema` or
 * `SchemaValidatorCache.get` first, so a single compiled validator can back
 * any number of `validateArgs` calls.
 */
export function validateArgs(validateFn: ValidateFunction, value: unknown): ValidationResult {
  if (validateFn(value)) return { valid: true };
  return { valid: false, errorText: ajvErrorsToText(validateFn.errors) };
}
