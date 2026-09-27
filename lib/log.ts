/**
 * One tagged line per event, through `console.*`, for the worker, `lib/` and
 * `app/` alike.
 *
 *     const log = logger('send_whatsapp');
 *     log.info('sent', { messageId });   // [send_whatsapp] sent messageId=…
 *     log.error('send failed', error);   // the error follows as its own argument
 *
 * **The `[tag]` prefix is the format**, and it does not change. Render's log
 * search and `docs/PROJECT-STATE.md` quote these lines by it, so a migration
 * moves every message across word for word: the tag becomes the argument to
 * `logger`, and the rest is the message.
 *
 * **Why not pino.** It would be the runtime tree's twelfth package, its
 * transports run in worker threads that fight Next's bundling, and JSON lines
 * break the `[tag]` grep the team already uses. What is wanted is one shape
 * everybody writes, and that fits in this file.
 *
 * **It never reads `env()`,** for the reason `lib/webhooks/log.ts` gives: a
 * diagnostic must not be able to fail the thing it describes, and `env()`
 * validates the whole schema.
 *
 * **It is never handed a header or a payload.** Fields are primitives by type,
 * so a request body cannot be spread into a line by accident. `lib/webhooks/log.ts`
 * stays the only thing that prints a raw delivery, because it redacts.
 */

type Primitive = string | number | boolean | null | undefined;

/** What a success line may carry beyond its message: primitives, by type. */
export type LogFields = Record<string, Primitive>;

/**
 * A warning or a failure takes the caught value instead of fields, and hands
 * it to `console.*` as a second argument, exactly as `console.error(line,
 * error)` did — so the stack still prints and a `cause` chain is not flattened
 * into a string. Every such line in the codebase is a message and the error.
 */
type Logger = {
  info(message: string, fields?: LogFields): void;
  warn(message: string, cause?: unknown): void;
  error(message: string, cause?: unknown): void;
};

export function logger(tag: string): Logger {
  const prefix = `[${tag}]`;

  // The method is looked up on every call, not captured here: a module makes
  // its logger at load, and a test that spies on `console.error` afterwards
  // must still see the line.
  const report =
    (level: 'warn' | 'error') =>
    (message: string, ...cause: unknown[]): void => {
      console[level](`${prefix} ${message}`, ...cause);
    };

  return {
    info: (message, fields) => console.log(`${prefix} ${message}${formatFields(fields)}`),
    warn: report('warn'),
    error: report('error'),
  };
}

/** ` key=value` for each field that has a value, in the order given. */
function formatFields(fields: LogFields | undefined): string {
  let out = '';
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value !== undefined) out += ` ${key}=${String(value)}`;
  }
  return out;
}
