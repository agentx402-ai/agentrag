// scripts/check-versions.mjs — the version-lockstep gate (RELEASING.md).
// Usage:
//   node scripts/check-versions.mjs           # all six sources agree with each other
//   node scripts/check-versions.mjs v0.2.3    # ...and each equals the given release tag
//
// Two automated callers, one implementation, so the two can no longer drift:
//   - ci.yml's `versions` job runs it with NO argument, on every pull request: the sources
//     must agree with each other, whatever the version happens to be.
//   - publish.yml's build job runs it WITH the resolved release tag, at the one moment a
//     mismatch becomes irreversible: a Release tagged v0.4.0 cut on a commit still carrying
//     0.3.1 would otherwise publish 0.3.1 under that Release. The VERSION constants are
//     compiled INTO the published bundles and the plugin's .mcp.json pin decides which CLI
//     actually runs for plugin users, so drift there ships packages that misreport themselves.
// The tag form is also the local pre-release check — run it by hand before cutting a release.
//
// This script has no dependencies beyond node: builtins and is never installed, so publish.yml
// can call it before `npm ci` without weakening the property that its guard runs no third-party
// code. Keep it that way.
import { readFileSync } from "node:fs";

// Sources resolve relative to the repo root (this file's parent), not the cwd, so the answer
// is the same from a workspace directory as from CI's checkout root.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const ver = (p) => JSON.parse(read(p)).version;
const konst = (p) => (read(p).match(/VERSION = "([^"]+)"/) || [])[1];

const v = {
  clientPkg: ver("client/package.json"),
  cliPkg: ver("cli/package.json"),
  clientConst: konst("client/src/index.ts"),
  cliConst: konst("cli/src/version.ts"),
  plugin: ver("plugin/agentrag/.claude-plugin/plugin.json"),
  // The plugin RUNTIME pin — the sixth source. Without it the lockstep never bound what
  // actually runs: .mcp.json spawns whatever @agentrag/cli is latest at install time.
  mcpPin: (read("plugin/agentrag/.mcp.json").match(/"@agentrag\/cli@([^"]+)"/) || [])[1],
};

// A regex/parse miss leaves the value undefined. Report it as "(not found)" — JSON.stringify
// drops undefined values outright, so the bare report would omit the one source that failed
// (and could print an empty `{}` when it is the only thing wrong).
const report = (pairs) =>
  JSON.stringify(
    Object.fromEntries(pairs.map(([k, got]) => [k, got === undefined ? "(not found)" : got])),
  );

// NO argument means "no tag to check" — ci.yml's `versions` job, which only ever exercises
// the source-agreement branch below. An argument that was PASSED BUT EMPTY is a hard error
// instead: it means a caller tried to resolve a release tag and came up empty, and silently
// downgrading that to the weaker sources-agree check is a release guard failing open.
// (publish.yml validates the tag shape before this runs, so it cannot hit this; the check is
// here so the next caller cannot reintroduce the hole.)
const tag = process.argv[2];
if (tag === "") {
  console.error("::error::empty tag argument — the caller failed to resolve a release tag");
  process.exit(1);
}
const want = tag === undefined ? undefined : tag.replace(/^v/, "");

if (want === undefined) {
  const uniq = [...new Set(Object.values(v))];
  if (uniq.length !== 1 || uniq[0] === undefined) {
    console.error(`::error::version sources diverge: ${report(Object.entries(v))}`);
    process.exit(1);
  }
} else {
  // Every source against the tag, and the full list of offenders in one message — not
  // first-failure — so a release that needs several bumps reports them all at once.
  const bad = Object.entries(v).filter(([, got]) => got !== want);
  if (bad.length) {
    console.error(`::error::tag ${tag} does not match: ${report(bad)}`);
    process.exit(1);
  }
}

// The seventh thing that moves in lockstep, and the only one that is not a bare version:
// cli must depend on exactly the client version being released beside it.
const expected = want ?? v.clientPkg;
const dep = JSON.parse(read("cli/package.json")).dependencies["@agentrag/client"];
if (dep !== `^${expected}`) {
  console.error(`::error::cli dependency on @agentrag/client (${dep}) != ^${expected}`);
  process.exit(1);
}
console.log(`ok: ${tag ? "tag + " : ""}all 6 version sources + cli->client dep at ${expected}`);
