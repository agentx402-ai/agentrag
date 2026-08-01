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

## Publish order (required)

Each higher package depends on a lower one at `^0.x`, so they publish bottom-up — **client, then
cli**. This order is enforced by `publish.yml` (OIDC trusted publishing): cutting the GitHub Release
runs the workflow, which publishes `@agentrag/client` before `@agentrag/cli`. Do NOT run
`npm publish` from a laptop — it bypasses provenance and, once the workflow has already published,
fails `EEXIST`. (Publishing a higher package before the one it depends on would `E404` for
consumers until the dependency lands; the enforced order prevents that.) If you also changed
`@agentx402-ai/core`, release it first from its own repo and bump the `^` range in `client`/`cli`.

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
