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
  `askAndWait` can genuinely settle a second payment for the re-ask leg.

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

- **`extend(collection, days)`** — push a collection's `expires_at` out by `30 | 60 | 90` days,
  without querying it first. Paid a flat, collection-size-independent price (see **Pricing**).

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
`usage.breakdown[]`, and the request's real cost is `price_usd` plus the sum of every breakdown
entry. This is genuinely easy to misread: a pay-on-success `ask` that doesn't match anything
reports `price_usd: 0` for its *own* leg even when the ingest leg it triggered genuinely settled —
reading `price_usd` alone can silently drop real, already-charged money from your accounting.

```ts
import { totalPriceUsd } from "@agentrag/client";

const result = await rag.ask("what is x?", { sources: ["https://example.com/x"] });
console.log(totalPriceUsd(result.usage)); // the real total: price_usd + every breakdown[].price_usd
```

**Pricing constants** (exported; the wire price on any given call always comes from the server's
`402` challenge — these drive this SDK's own pre-signature ceiling math, documented here so the
numbers below are traceable):

| Constant | Value | What it prices |
|---|---|---|
| `ASK_BASE_USD` | $0.008 | A flat `ask` with no ingest needed |
| `INGEST_PAGE_USD` | $0.005 | Each ingested page or `documents[]` entry |
| `EXTEND_BLOCK_USD` | $0.01 | Each 30-day unit of an `extend` call |
| `DEFAULT_MAX_OP_USD` | $0.05 | Built-in per-op ceiling when no `maxSpendUsd` is set (see **Money-safety**) |

A composite `ask` (one that also ingests) settles as **one** ingest-denominated charge:
`(pages ingested + 2) × INGEST_PAGE_USD` — the `+ 2` is `ASK_BASE_USD` expressed in
ingest-price units, never a separate second payment. `extend` is flat regardless of collection
size: `days / 30` times `EXTEND_BLOCK_USD`, so 30 days costs `EXTEND_BLOCK_USD` ($0.01) and 90
days costs three times that ($0.03).

Client-side request limits, enforced before any request is sent (so a malformed call never burns
a wallet-mode signature the server was always going to reject): `MAX_QUERY_CHARS` (1,000),
`MAX_TOP_K` (20), `MAX_PAGES_PER_CALL` (200), `MAX_DOCUMENTS` (100), `MAX_DOCUMENT_BYTES` (100 KiB
per document, UTF-8 bytes).

## Collection lifetime

A collection's `expires_at` slides forward on paid use (an `ask` or `ingest` against it) rather
than being fixed at creation — `extend(collection, days)` is how you push it out explicitly,
without waiting for paid traffic or querying the collection first. Watch `expiring_soon: true` on
a result's `usage` block (present in the final 24h of a collection's life) as your cue to query it
again or call `extend`.

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
