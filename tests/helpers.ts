// Shared test helpers. Previously duplicated verbatim across
// tests/binding.test.ts, tests/schema.test.ts, tests/credentials.test.ts, and
// tests/retry.test.ts because none of them exported it — see Task 10's
// hygiene item on this. Kept in one place now so the copies cannot drift.
import { vi } from 'vitest';

/**
 * Runs `fn` with process.stderr.write mocked out and returns everything it
 * wrote, joined. Writes are collected into a local array rather than read off
 * the spy afterwards: vitest's `mockRestore` also resets the spy's call
 * history, so any assertion made on the spy after restoring would read an
 * empty history and pass vacuously.
 */
export function captureStderr(fn: () => void): string {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return writes.join('');
}

/**
 * Async variant of `captureStderr`: `fn` may write to stderr after an
 * `await` (e.g. `run`'s retry loop), so the spy must still be in place when
 * that write happens. Same accumulate-inside-the-mock shape and the same
 * reason for it.
 */
export async function captureStderrAsync(fn: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return writes.join('');
}

/** Same as `captureStderr`, but for a function that returns a value. */
export function captureStderrWithResult<T>(fn: () => T): { stderr: string; result: T } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  let result: T;
  try {
    result = fn();
  } finally {
    spy.mockRestore();
  }
  return { stderr: writes.join(''), result };
}
