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

/**
 * Global config flags — valid alongside ANY command. `cli.ts` consumes these itself (a single
 * `parseFlags(rest).flags` call feeding `resolveConfig`, BEFORE dispatching into the specific
 * command) — a verb command's OWN (second) `parseFlags` call never reads them again, but must
 * still tolerate their presence so `agentrag ask "q" --max-spend-usd 5 --collection docs` keeps
 * working. Every per-command allowlist below spreads this set in for exactly that reason.
 */
export const GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "endpoint",
  "network",
  "max-spend-usd",
  "max-session-spend-usd",
]);

// Per-command flag allowlists — closes the review finding "every command accepts every other
// command's flags and silently drops them" (e.g. `agentrag ask q --refresh` used to parse clean
// and do nothing: AskOptions has no `refresh` wiring in ask.ts, so the flag was silently
// dropped — a billing-relevant surprise, since a user asking for "fresh" data silently got a
// cached collection instead). Each command below passes its own set as parseFlags's `allowed`
// param, so a flag that's globally known but wrong for THIS command is now a usage error
// instead of a no-op.
export const ASK_FLAGS: ReadonlySet<string> = new Set([
  ...GLOBAL_FLAGS,
  "sources",
  "collection",
  "top-k",
  "mode",
  "max-pages",
  "wait",
]);
export const INGEST_FLAGS: ReadonlySet<string> = new Set([
  ...GLOBAL_FLAGS,
  "sources",
  "documents",
  "collection",
  "model",
  "max-pages",
  "refresh",
  "wait",
]);
export const EXTEND_FLAGS: ReadonlySet<string> = new Set([...GLOBAL_FLAGS, "days"]);
export const STATUS_FLAGS: ReadonlySet<string> = new Set(GLOBAL_FLAGS);
export const DELETE_FLAGS: ReadonlySet<string> = new Set(GLOBAL_FLAGS);
// `wallet show` is dispatched BEFORE config resolution and never calls resolveConfig (see
// cli.ts), so it has no use for the global config flags either — the strictest of the six,
// accepting none at all.
export const WALLET_FLAGS: ReadonlySet<string> = new Set();

function camel(k: string): string {
  return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * ask / delete / extend / status each take EXACTLY ONE positional. Silently using only
 * `positionals[0]` and dropping the rest is a money/data trap: an unquoted multi-word query
 * — `agentrag ask what is x` — arrives as three positionals and the command would pay for the
 * ask "what"; `agentrag delete a b c` would delete only "a". Returns a usage message when
 * there is more than one positional, else undefined.
 */
export function extraPositionalError(
  positionals: string[],
  command: string,
  name: string,
): string | undefined {
  if (positionals.length > 1) {
    return `${command} takes a single <${name}> but got ${positionals.length} (${JSON.stringify(
      positionals,
    )}) — quote it if it contains spaces`;
  }
  return undefined;
}

/**
 * @param allowed When given, restricts accepted flags to exactly this set (see the
 *   per-command *_FLAGS constants above) — a flag outside it is a usage error even when it's
 *   globally known, so a command can no longer silently accept and drop another command's flag.
 *   Omitted entirely by cli.ts's own top-level parse (which must tolerate every verb's flags
 *   alongside the global config ones, since it only extracts the config subset).
 */
export function parseFlags(
  args: string[],
  allowed?: ReadonlySet<string>,
): {
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
      if (allowed !== undefined && !allowed.has(key)) {
        throw new UsageError(`flag --${key} is not valid for this command`);
      }
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
    } else if (a.startsWith("-") && !a.startsWith("--") && KNOWN_FLAGS.has(a.slice(1))) {
      // A SINGLE-dash token that EXACTLY names a known flag is a typo (`-collection`,
      // `-max-spend-usd`), not a positional. Left as a positional it would defeat the
      // fail-closed unknown-flag guard above: `-max-spend-usd 5` would silently become two
      // positionals and leave the cap unset on real funds. Only a known-flag match is rejected,
      // so a free-text query that merely begins with a dash (e.g. `ask "-ish suffix"`) still
      // parses as a positional.
      throw new UsageError(
        `unknown flag ${a} (did you mean --${a.slice(1)}? flags use two dashes)`,
      );
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}
