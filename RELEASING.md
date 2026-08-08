# Releasing

AgentRAG ships two coordinated npm packages (`@agentrag/client`, `@agentrag/cli`) plus a
Claude Code plugin. They MUST be published together, in dependency order, at the same version. The
shared `@agentx402-ai/core` is released separately from [its own repo](https://github.com/agentx402-ai/core).

## Version sources (keep in sync)

Seven sources move in lockstep on every release — six in this repo, plus one cross-repo pin:

1. `client/package.json` — the published `@agentrag/client` version
2. `cli/package.json` — the published `@agentrag/cli` version
3. `client/src/index.ts` (`VERSION`) — reported by the SDK
4. `cli/src/version.ts` (`VERSION`) — `agentrag --version` and the MCP server handshake
5. `plugin/agentrag/.claude-plugin/plugin.json` (`version`)
6. `plugin/agentrag/.mcp.json` — the MCP runtime pin (`@agentrag/cli@<version>` in `args`).
   Without it the plugin spawns whatever is latest at install time, so the lockstep binds the
   declared version but not the one that actually runs.
7. `agentx402-ai/claude-plugins` → `.claude-plugin/marketplace.json` (the `agentrag` plugin's
   `source.ref`) — the cross-repo pin the shared marketplace serves; synced on release (step 7).

The CI `versions` job cross-checks all **six in-repo** sources AND the cli→client dependency
range (`cli/package.json`'s `@agentrag/client` must be `^<clientVersion>`); it fails if any
diverge. The seventh (marketplace) pin lives in another repo and is synced automatically on release.

All six in-repo sources are checked at **three call sites**, deliberately not one shared
implementation: `ci.yml`'s `versions` job and `publish.yml`'s `build` job both invoke
`scripts/check-versions.mjs` (the `build` job passes it the resolved release tag, so the
check is against that tag, not merely against the other sources); `publish.yml`'s privileged
`publish` job carries its own **independent inline** re-check of the same six sources
immediately before `npm publish`, and deliberately never calls the shared script. Both gates
in `publish.yml` exist to catch the same class of mistake independently of each other; calling
the shared script from both would collapse them into one implementation, and a single bad
edit to it (or to the script it wraps) could then silently weaken every gate at once instead
of just one. Keep the inline copy in sync with the script by hand when a version source is
added or renamed — that manual sync is the price of the independence.

## Publish order (required)

Each higher package depends on a lower one at `^0.x`, so they publish bottom-up — **client, then
cli**. This order is enforced by `publish.yml` (OIDC trusted publishing): cutting the GitHub Release
runs the workflow, which publishes `@agentrag/client` before `@agentrag/cli`. Do NOT run
`npm publish` from a laptop — it bypasses provenance and, once the workflow has already published,
fails `EEXIST`. (Publishing a higher package before the one it depends on would `E404` for
consumers until the dependency lands; the enforced order prevents that.) If you also changed
`@agentx402-ai/core`, release it first from its own repo and bump the `^` range in `client`/`cli`.

## First publish of a NEW package (one time only — does not apply here again)

**The "never `npm publish` from a laptop" rule above cannot apply to a package that does not exist
yet.** npm will not let you configure a trusted publisher for a package name that has never been
published, so OIDC has nothing to attach to and the workflow cannot make the first release. Every
package in this org took this path: `@agentrag/client` and `@agentrag/cli` `0.1.0`, like
`@agentkv/client` `0.1.0`–`0.1.2`, `@agentscout/client` `0.1.0`–`0.1.2` and `@agentx402-ai/core`
`0.1.0`, carry **no provenance attestation**. Every version after each package's bootstrap does.

If you are standing up a new package (a fourth service, a split-out library), the order is:

1. **Generate a classic _Automation_ token.** 2FA is enforced on publish for this org, and only an
   Automation token bypasses it — a granular or "publish" token fails `EOTP` and drops into an
   interactive browser-auth prompt that cannot complete in a script.
2. `npm publish -w client` then `npm publish -w cli`, **in that order** (`cli` depends on `client`
   at `^x.y.z`; reversed, the CLI is installable and broken until the dependency lands).
3. **Configure Trusted Publishing** on npmjs.com for **both** packages.
4. **Delete the Automation token.** From here the rule at the top of this section is true again.

Two traps worth knowing before you hit them:

- **`npm publish --dry-run` exits 0 regardless.** It never contacts the publish endpoint, so it
  cannot surface `EOTP` and tells you nothing about whether a token can actually publish.
- **The registry's read path can lag its write path by minutes.** During the AgentRAG bootstrap,
  `client` returned 404 for ~200s *after* a successful publish while `cli`, published after it, was
  already live — so `npm i` of the CLI failed on an unresolvable dependency in between. If a
  just-published package 404s, **retry the publish**: `E403 cannot publish over the previously
  published versions` proves it landed and only the read path is behind. Never republish blindly,
  and never unpublish.

## Steps

1. Bump every version source above (the six in-repo sources, including the `.mcp.json` runtime
   pin, and the cli→client dep range) to the new version.
2. Update `CHANGELOG.md` — add a dated `## [<version>]` section for the release.
3. `npm ci && npm run lint && npm run build && npm test` — all green.
4. `npm pack --dry-run --workspaces` — confirm each tarball's contents.
5. Publishing is automated — do NOT run `npm publish` by hand. Cutting the Release (next step)
   runs `publish.yml`, which publishes client then cli via OIDC in the enforced order above.
6. Cut the GitHub Release: `gh release create v<version> --generate-notes`. This tags AND
   publishes a Release — a plain `git push --tags` will NOT fire the publish or the marketplace
   auto-sync. Publishing the Release runs `publish.yml` (OIDC trusted publishing, client then cli).

### Prereleases

A tag with a semver prerelease suffix (`v0.5.0-rc.1`) publishes to the **`next`** npm dist-tag,
never `latest`, so `npm install @agentrag/cli` keeps resolving to the last stable release. Cut
it with `gh release create v0.5.0-rc.1 --prerelease --generate-notes`. The marketplace pin is
deliberately NOT moved by a prerelease — `marketplace.json` serves one `source.ref` per plugin,
so pinning an rc would point every plugin install at a prerelease CLI.

### If the publish fails

`publish.yml` runs from the tag it publishes, so a fix pushed to `main` does not apply to an
already-cut Release. Recovery depends on what failed:

- **Transient (registry blip, rate limit):** "Re-run all jobs" on the run, or
  `gh workflow run publish.yml --ref v<version>`. It must run FROM THE TAG — a branch dispatch
  is refused, because npm builds provenance from `GITHUB_REF` and a dispatch from `main` would
  attest the tag's code under main's HEAD. There is no `tag` input for this reason.
- **Half-published** (client landed, cli did not): re-run. The publish steps skip an
  already-published exact version on a re-run attempt, so the run completes the missing half.
- **A bug in the workflow itself:** it cannot be fixed by re-running, since the run executes the
  workflow file at its own ref. Move the tag onto a commit carrying both the fix and the matching
  versions, or bump every source and cut the next version.
7. The marketplace pin then syncs automatically: publishing the Release dispatches to
   `agentx402-ai/claude-plugins` (`.github/workflows/notify-marketplace.yml` here), which pins the
   `agentrag` plugin's `source.ref` to `v<version>`. Manual fallback: re-run
   `notify-marketplace.yml` via `workflow_dispatch` with the release tag.
