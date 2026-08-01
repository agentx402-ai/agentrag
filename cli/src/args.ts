/**
 * A user/argument error (missing flag value, malformed numeric flag). Distinct from a
 * runtime failure so runCli's mapError can return EXIT.USAGE (2), not the generic EXIT (1) —
 * scripts branch on that code.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

// Every long flag the CLI accepts, across all commands. An unknown flag is rejected
// (fail-closed) rather than silently swallowed — a typo like `--max-spend-us 5` must not
// slip through as a no-op and leave a spend cap unset on real funds.
//
// Deviation from the Scout template (deliberate, per the task brief): Scout's inert
// --json/--pretty/--reveal flags (declared but never read by any command) are NOT carried
// over here.
const KNOWN_FLAGS = new Set([
  "endpoint",
  "network",
  "max-spend-usd",
  "max-session-spend-usd",
  "sources",
  "collection",
  "top-k",
  "mode",
  "max-pages",
  "wait",
  "documents",
  "model",
  "refresh",
  "days",
]);
const BOOL_FLAGS = new Set(["wait", "refresh"]);
const NUM_FLAGS = new Set(["max-spend-usd", "max-session-spend-usd", "top-k", "max-pages", "days"]);
// Repeatable flags accumulate into a string[] instead of the last value overwriting the rest.
// AgentRAG is the first of the sibling CLIs to need this: `ask`/`ingest` accept `--sources`
// more than once (`agentrag ask <query> --sources URL --sources URL ...`).
const MULTI_FLAGS = new Set(["sources"]);

function camel(k: string): string {
  return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function parseFlags(args: string[]): {
  flags: Record<string, unknown>;
  positionals: string[];
} {
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (!KNOWN_FLAGS.has(key)) throw new UsageError(`unknown flag --${key}`);
      const boolish = BOOL_FLAGS.has(key);
      const val = boolish ? true : args[++i];
      // A value-expecting flag MUST get a real value. Missing (`--collection` at end), empty
      // (`--collection ""`), or flag-like (`--collection --wait`) values would otherwise be
      // silently swallowed. Fail loud instead (caught by runCli's mapError).
      if (!boolish && (val === undefined || val === "" || (val as string).startsWith("--"))) {
        throw new UsageError(`flag --${key} requires a value`);
      }
      if (NUM_FLAGS.has(key)) {
        // Numeric flags MUST be a finite, non-negative number — mirror the env path's
        // fail-CLOSED behavior (config.ts numOrThrow). Otherwise a typo like
        // `--max-spend-usd 0,05` -> NaN is non-nullish, so it wins over a valid env cap AND
        // `usd > NaN` is always false, silently DISABLING the spend cap on real funds.
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0) {
          throw new UsageError(
            `flag --${key} must be a non-negative number (got ${JSON.stringify(val)})`,
          );
        }
        flags[camel(key)] = n;
      } else if (MULTI_FLAGS.has(key)) {
        const arr = (flags[camel(key)] as string[] | undefined) ?? [];
        arr.push(val as string);
        flags[camel(key)] = arr;
      } else {
        flags[camel(key)] = val;
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}
