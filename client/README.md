# @agentrag/client

The TypeScript SDK for **AgentRAG** — an agent-native retrieval-augmented-generation service paid
per call over [x402](https://x402.org). Point it at your own documents (exact URLs, a same-origin
crawl, or raw text) and ask questions against them: retrieval combines **hybrid BM25 + vector
search**, ingestion runs on demand or explicitly, and every paid call settles in **USDC** on Base,
with no signup and no API keys.

**Wallet-native by default** — a signable EVM wallet pays each call inline via x402 — with an
opt-in **account-key mode** (an `ak_…` bearer token that debits prepaid credits, funded out-of-band
via AgentKV) for managed wallets that can't sign.

```bash
npm install @agentrag/client
```

```ts
import { AgentRag } from "@agentrag/client";

const rag = new AgentRag({
  privateKey: process.env.PRIVATE_KEY as `0x${string}`,
  endpoint: "https://api.agentx402.ai",
});

const result = await rag.ask("what does this page say about pricing?", {
  sources: ["https://example.com/pricing"],
});
if ("chunks" in result) console.log(result.chunks);
```

### Account-key mode (managed wallets that can't sign)

Pass an `ak_…` bearer token instead of a wallet. The bearer is the identity and each paid call
debits the account's prepaid credits; any signing wallet funds it out-of-band via AgentKV.

```ts
import { AgentRag } from "@agentrag/client";

const rag = new AgentRag({
  accountKey: process.env.AGENTRAG_ACCOUNT_KEY, // ak_<64 hex>
  endpoint: "https://api.agentx402.ai",
});

const result = await rag.ask("what does this page say about pricing?", { collection: "my-docs" });
```

An `insufficient_credits` `402` throws a typed error — fund the account out-of-band via AgentKV;
this SDK has no funding path of its own. The two auth shapes are mutually exclusive: construct with
exactly one of `{ privateKey }`, `{ signer }`, or `{ accountKey }`.

## Verbs

- **`ask(query, { sources?, collection?, topK?, mode?, maxPages?, refresh?, idempotencyKey? })`** —
  ask a question. Give it `sources` to ingest on demand (when the target collection doesn't exist
  yet, or `refresh` is set) or `collection` to target one you already built. `mode` is one of
  `"hybrid" | "dense" | "bm25"`; omit it to use the service's own default. Paid: the flat ask price
  when no ingest is needed, or one composite ingest-denominated charge when `sources` triggers one
  (see **Pricing** below) — never a separately-signed second payment.

  A large `sources` set (a crawl root, or more than a few new/refreshed exact URLs) can't finish
  inline: `ask` then resolves as `AskPending` (`status: "ingesting"`), not an error. Discriminate
  with `"chunks" in result`, or use `askAndWait` to block until it resolves.

- **`askAndWait(query, opts)`** — `ask`, but transparently polls out a pending ingest instead of
  returning `AskPending`, and always resolves a settled `AskResult`. Extra options: `maxWaitMs`
  (default 120s, throws `ingest_timeout` — the ingest itself keeps running server-side) and
  `pollIntervalMs` (defaults to the pending response's own `retry_after`).

  **Idempotency caveat — read before relying on retries.** Internally, `askAndWait` re-asks the
  now-resolved collection once ingestion finishes. If you pass your own `idempotencyKey`, the
  re-ask derives a distinct key (`` `${idempotencyKey}:ask` ``) rather than reusing yours verbatim
  or dropping it — so each of the two legs (the initial call, and the eventual re-ask) is
  exactly-once **on its own**, but they are still two separate charges, not one. If you pass **no**
  `idempotencyKey`, every `ask()` call underneath — including the re-ask — gets a fresh nonce, same
  as calling `ask()` directly with no key. The practical consequence: re-running a whole
  `askAndWait` call after a network blip (a lost response, a client crash) is only exactly-once
  end-to-end if you supplied your own `idempotencyKey` up front. Without one, a retried
  `askAndWait` can genuinely settle a second payment for **either** leg — including the initial
  call, which on a composite ask is the expensive, ingest-denominated one.

  ```ts
  const result = await rag.askAndWait("what does this page say about pricing?", {
    sources: ["https://example.com/pricing/**"],
    idempotencyKey: "pricing-lookup-2026-08-01", // exactly-once per leg across retries
  });
  console.log(result.chunks);
  ```

- **`ingest({ sources?, documents?, collection?, model?, maxPages?, refresh?, idempotencyKey? })`**
  — explicit pre-warm, or the only way to index raw `documents` (`{ text, title?, url? }`, no URL
  required) or force a `refresh` re-fetch. Paid per page/document unit (never composited the way
  `ask`'s on-demand leg is). `model` is fixed at collection creation — omit it to inherit an
  existing collection's, or to use `DEFAULT_MODEL` on a new one; passing a different model against
  an existing collection is rejected (`model_mismatch`). Valid models are exported as
  `RAG_MODELS`. Like `ask`, a source set needing a durable job resolves as `AskPending` instead of
  an error.

  ```ts
  await rag.ingest({ sources: ["https://example.com/docs/**"], collection: "my-docs" });

  await rag.ingest({
    documents: [{ text: "Refunds are available within 30 days.", title: "Refund policy" }],
    collection: "my-docs",
  });
  ```

- **`extend(collection, days)`** — push a collection's `expires_at` out by `30 | 60 | 90` days.
  Paid, priced on the collection's real chunk count (see **Pricing**) — in wallet mode this method
  makes a free `status()` read first to price it accurately and to refuse upfront
  (`extend_too_large_for_wallet_mode`) when the collection is too large for a single wallet-mode
  payment; account-key mode skips that read (it has no such limit).

  ```ts
  await rag.extend("my-docs", 90);
  ```

- **`status(collection)`** — free, identity-signed (or bearer) metadata read: `model`, `pages`,
  `chunks`, `created_at`, `expires_at`, and a `job` block (`state: "running" | "complete" |
  "failed"`) describing the collection's ingest history, when it has any.
- **`delete(collection)`** — free, identity-signed (or bearer) immediate purge.

  Both are owner-gated: a collection that doesn't exist and one owned by someone else return the
  identical `collection_not_found` (no existence oracle); a collection you genuinely own but that
  expired before being purged returns `collection_expired` (410).

## Usage and pricing

Every paid result carries a `usage` block. **Read `totalPriceUsd(result.usage)`, not
`usage.price_usd` alone** — `price_usd` is only the *primary verb's* price on the path taken; a
composite `ask` that also ingested pages settles its ingest leg(s) as additional entries in
`usage.breakdown[]`, and `totalPriceUsd` is `price_usd` plus the sum of every breakdown entry. This
is genuinely easy to misread: a pay-on-success `ask` that doesn't match anything reports
`price_usd: 0` for its *own* leg even when the ingest leg it triggered genuinely settled — reading
`price_usd` alone can silently drop real, already-charged money from your accounting.

`totalPriceUsd` is what the request **settled**, not your final net spend — treat it as
gross-of-refund. A breakdown ingest leg is quoted (and settled) on the *worst-case* page count the
call authorized, not the pages actually found; the unused remainder comes back separately as
**credits**, visible via the result's `creditsRemaining`, never subtracted from `breakdown[]`
itself. A crawl that authorizes 20 pages but only finds 3 settles for 20 and refunds 17 as credits
— `totalPriceUsd` reports the 20-page amount either way.

```ts
import { totalPriceUsd } from "@agentrag/client";

const result = await rag.ask("what is x?", { sources: ["https://example.com/x"] });
console.log(totalPriceUsd(result.usage)); // what settled: price_usd + every breakdown[].price_usd
console.log(result.creditsRemaining); // any unused-page refund shows up here, as credits
```

**Pricing constants** (exported; the wire price on any given call always comes from the server's
`402` challenge — these drive this SDK's own pre-signature ceiling math, documented here so the
numbers below are traceable). All four rows are **wallet-mode (x402) prices**; the account-key
(credit) path is **20% cheaper** — the service prices credit spend at 80% of these numbers:

| Constant | Value | What it prices |
|---|---|---|
| `ASK_BASE_USD` | $0.008 | A flat `ask` with no ingest needed |
| `INGEST_PAGE_USD` | $0.005 | Each ingested page or `documents[]` entry |
| `EXTEND_BLOCK_USD` | $0.01 | Each 30-day unit, per extend block (see below) |
| `DEFAULT_MAX_OP_USD` | $0.05 | Built-in per-op ceiling when no `maxSpendUsd` is set (see **Money-safety**) |

A composite `ask` (one that also ingests) settles as **one** ingest-denominated charge:
`(worst-case pages authorized + 2) × INGEST_PAGE_USD` — the `+ 2` is `ASK_BASE_USD` expressed in
ingest-price units, never a separate second payment. `maxPages` defaults to **20** when omitted, so
an `ask`/`ingest` over a `/**` crawl root with no explicit `maxPages` authorizes 22 (ask) or 20
(ingest) ingest-price units by default — both above the `$0.05` `DEFAULT_MAX_OP_USD` backstop, which
is fine because these verbs always declare their own ceiling (see **Money-safety**), but worth
knowing before you're surprised by the quote.

`extend` is priced on the collection's **real chunk count**, not a flat rate:
`max(1, ceil(chunks / CHUNKS_PER_BLOCK))` blocks (capped at 5, since a collection caps at 25,000
chunks) times `days / 30`, at `EXTEND_BLOCK_USD` per unit — a 30-day extend on a collection under
5,000 chunks costs `EXTEND_BLOCK_USD` ($0.01); a 12,000-chunk collection needs 3 blocks. **Wallet
mode can only pay for 1 block per call**: the server's pre-auth quote is deliberately blind to
collection size (so an unauthenticated probe can't be used to learn it), and a signed x402
authorization can never exceed what that quote states. `extend()` checks the real chunk count via
a free `status()` call first and throws `extend_too_large_for_wallet_mode` before ever signing when
more than one block is needed. Account-key mode has no such limit — the worker debits the real
per-block price directly for a collection of any size.

Client-side request limits, enforced before any request is sent (so a malformed call never burns
a wallet-mode signature the server was always going to reject): `MAX_QUERY_CHARS` (1,000),
`MAX_TOP_K` (20 — the service currently returns 8 chunks by default when `topK` is omitted),
`MAX_PAGES_PER_CALL` (200), `MAX_DOCUMENTS` (100), `MAX_DOCUMENT_BYTES` (100 KiB per document,
UTF-8 bytes).

## Collection lifetime

A collection's `expires_at` is not fixed at creation — it can slide forward on paid use, but only
conditionally, and the safe remedy is `extend()`, not "use it again":

- `ingest` always slides `expires_at` forward.
- `ask` slides it **only** when the query actually matched (`result.matched === true`). A
  no-match `ask` is free and does **not** extend the collection, and neither does an idempotency
  replay — so relying on query traffic to keep a collection alive can silently fail.
- **Expiry is terminal.** Neither paid traffic nor `extend()` revives an already-expired
  collection — recovery is re-ingesting from scratch. Watch `expiring_soon: true` on a result's
  `usage` block (present in the final 24h of a collection's life) and call `extend(collection,
  days)` before that window closes if you want the lifetime under your own control rather than
  contingent on query traffic.

## Money-safety

- **The SDK signs the challenge's exact quoted amount** — never a self-computed sum — pinning the
  network, the canonical USDC token, and (when you set `expectedPayTo`) the recipient, all checked
  **before** any signature is produced. A `402` quoting more than this SDK authorized for the
  request's own shape (see **Pricing**) is refused pre-signature, even with no `maxSpendUsd` set —
  and when an op declares no ceiling of its own, `DEFAULT_MAX_OP_USD` backstops it.
- **Spend caps.** `maxSpendUsd` (per call) and `maxSessionSpendUsd` (cumulative across the client,
  reservation-based so concurrent calls can't all pass the same stale check) throw `SpendCapError`
  before the challenge is signed. Both must be finite and non-negative — a malformed value throws
  `invalid_config` at construction; "no cap" is expressed by omitting the option, never by passing
  `Infinity`.

## Errors

Every failure — from client-side validation, a worker rejection, or a transport error — is a typed
error with a stable `.code`; callers should branch on `.code`, not on the error's class:

```ts
import { AgentXError } from "@agentrag/client";

try {
  await rag.ask("...", { collection: "my-docs" });
} catch (e) {
  if (!(e instanceof AgentXError)) throw e; // not one of ours — rethrow

  switch (e.code) {
    case "spend_cap_exceeded": // maxSpendUsd / maxSessionSpendUsd / the built-in op ceiling
      break;
    case "collection_not_found":
    case "collection_expired":
      break;
    case "insufficient_credits": // account-key mode: no wallet to pay with — top up via AgentKV
      break;
    default:
      throw e;
  }
}
```

`SpendCapError` and the SDK's own `AgentRagError` are both `AgentXError` subclasses (from
`@agentx402-ai/core`) — catch `AgentXError` to cover either. `AgentRagError` additionally carries
an optional `.hint` string when the worker sends one. The full code set is exported as the
`RagErrorCode` union.

See [agentx402.ai](https://agentx402.ai) for the platform's service docs and pricing.

## License

[MIT](./LICENSE)
