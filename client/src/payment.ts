// client/src/payment.ts
//
// Back-compat / single-import surface over @agentx402-ai/core's caller-side x402 helpers.
// The SDK pays THROUGH these — it never wires x402Client/ExactEvmScheme itself.
import { decodeBase64Utf8 } from "@agentx402-ai/core";

export {
  buildBearerHeaders,
  buildIdentityHeaders,
  buildPaymentHeader,
  challengePriceUsd,
  decodeBase64Utf8,
  freshNonce,
  nonceFromIdempotencyKey,
  type Signer,
} from "@agentx402-ai/core";

// ---- AgentRAG-specific response-header parsing -----------------------------------
//
// Unlike AgentScout's SDK (which reads neither response header — its accounting rides
// the body only), AgentRAG's worker also emits PAYMENT-RESPONSE and
// X-AgentKV-Credits-Remaining on a paid 200. No Scout template to adapt for this part;
// the shape mirrors `@agentkv/client`'s own (private) settledTxHash helper, exported
// here as reusable pure functions of a Response so ask()/ingest()/extend() can surface
// the settle receipt and credits remainder on their own result types.

/**
 * The on-chain settlement txHash from a response's PAYMENT-RESPONSE header, or "" when
 * the op settled on credits (nothing moved on-chain) or the header is absent. The worker
 * emits PAYMENT-RESPONSE = base64(JSON `{ success, payer, amount, txHash }`) on any paid
 * 200, with `txHash: ""` on the credit hot path — the same shape `@agentkv/client`
 * decodes.
 */
export function settledTxHash(res: Response): string {
  const header = res.headers.get("PAYMENT-RESPONSE");
  if (!header) return "";
  try {
    // UTF-8 decode to mirror the backend's base64/UTF-8 encoding (see decodeBase64Utf8).
    const parsed = JSON.parse(decodeBase64Utf8(header)) as { txHash?: unknown };
    return typeof parsed.txHash === "string" ? parsed.txHash : "";
  } catch {
    return "";
  }
}

/**
 * Prepaid-credit balance remaining after this op, from the X-AgentKV-Credits-Remaining
 * response header — present iff a real balance was read this call (never fabricated).
 * `undefined` when the header is absent or unparsable; never coerced to 0 (0 is itself a
 * meaningful, distinct balance).
 */
export function creditsRemaining(res: Response): number | undefined {
  const raw = res.headers.get("X-AgentKV-Credits-Remaining");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
