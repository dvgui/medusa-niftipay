# Niftipay Refund Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Medusa-issued Niftipay refunds resolve and validate the exact remote fiat order before sending one refund mutation, while preserving partial-refund support.

**Architecture:** Extend the normalized Niftipay order with the processor fields exposed by the authenticated order lookup. `refundPayment` will perform a read-only lookup using the durable public UUID first and the stored internal key as a safe fallback, validate the remote identity/integration/currency/cart and PSP record, then submit exactly one refund request with the canonical remote order key. No mutation retry or legacy `DELETE` fallback is allowed.

**Tech Stack:** TypeScript 5.9, Medusa v2.13 payment provider API, Bun test runner, Niftipay REST API.

## Global Constraints

- Do not trigger a real refund; all refund POSTs in tests must use mocked `fetch`.
- Never log or persist API keys, webhook secrets, customer data, or raw Niftipay responses.
- Keep `POST /api/fiat/orders/:orderKey/refunds` as the only explicit refund mutation.
- Allow partial and multiple refunds and convert Medusa major units to ISO-correct minor units.
- A failed or ambiguous mutation must never be retried automatically under another identifier.

---

### Task 1: Normalize refund-readiness fields

**Files:**
- Modify: `src/lib/niftipay-client/types.ts`
- Modify: `src/lib/niftipay-client/normalize.ts`
- Test: `src/lib/niftipay-client/normalize.test.ts`

**Interfaces:**
- Consumes: authenticated `GET /api/fiat/orders/:identifier` order data.
- Produces: `NiftipayRemoteOrder.pspOrderId`, `.pspStatus`, and `.pspTransactionCount`.

- [ ] **Step 1: Write the failing normalization test**

Add a case that calls `normalizeNiftipayOrder` with `pspOrderId`, `pspStatus`, and `pspTransactionCount`, then expects trimmed/lower-cased/numeric values.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `bun test src/lib/niftipay-client/normalize.test.ts`

Expected: FAIL because the normalized result does not yet contain the processor fields.

- [ ] **Step 3: Add the typed fields and normalization**

Extend `NiftipayRemoteOrder` with:

```ts
pspOrderId?: string
pspStatus?: string
pspTransactionCount?: number
```

Populate them in `normalizeNiftipayOrder` with `optionalString` / `optionalNumber`, lower-casing `pspStatus` consistently with `status`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `bun test src/lib/niftipay-client/normalize.test.ts`

Expected: PASS.

### Task 2: Resolve and validate a canonical refund target

**Files:**
- Modify: `src/providers/niftipay/service.ts`
- Test: `src/providers/niftipay/service.test.ts`

**Interfaces:**
- Consumes: stored `niftipay_order_id`, `niftipay_order_key`, `niftipay_integration_id`, `niftipay_currency`, and `niftipay_merchant_reference`.
- Produces: a canonical `NiftipayRemoteOrder` whose `orderKey` is used for one refund request.

- [ ] **Step 1: Write failing provider tests**

Add mocked-fetch cases proving that the provider:

```ts
// Public UUID lookup returns the canonical key, then only one POST is sent.
GET /api/fiat/orders/<public UUID> -> {
  order: {
    id: <public UUID>,
    orderKey: 33351,
    integrationId: "test-integration-id",
    merchantReference: <cart ID>,
    currency: "GBP",
    status: "completed",
    pspOrderId: "processor-order",
    pspTransactionCount: 1,
  },
}
POST /api/fiat/orders/33351/refunds -> { ok: true }
```

Also add rejection cases for a mismatched integration, currency, merchant reference, public UUID, or missing `pspOrderId`, asserting that no POST occurs. Add a safe lookup-fallback case where the public UUID GET fails and the stored key GET succeeds.

- [ ] **Step 2: Run the focused provider tests and verify they fail**

Run: `bun test src/providers/niftipay/service.test.ts`

Expected: FAIL because `refundPayment` currently sends the POST without a preflight GET.

- [ ] **Step 3: Implement read-only resolution and identity checks**

Add a private helper that tries unique non-empty candidates in this order:

```ts
[data.niftipay_order_id, data.niftipay_order_key]
```

Each attempt calls `retrieveNormalizedFiatOrder`. Once resolved, require the remote public UUID and integration/currency/cart values to match any stored counterparts. Require a non-empty remote `orderKey` and `pspOrderId`; treat an explicit `pspTransactionCount <= 0` as not refundable. If no candidate resolves, throw a clear `MedusaError` without a refund POST.

- [ ] **Step 4: Submit one mutation with the canonical key**

Convert `input.amount` using `toMinorUnits`, call `createFiatRefund(remote.orderKey, payload)` exactly once, and return merged payment data containing the canonical public UUID/key plus `niftipay_status: "refund_requested"` and the last requested amount.

- [ ] **Step 5: Run focused tests and verify they pass**

Run: `bun test src/providers/niftipay/service.test.ts`

Expected: PASS, including assertions that validation failures issue zero POSTs.

### Task 3: Document, validate, build, and release

**Files:**
- Modify: `README.md`
- Generated: `.medusa/server/**`
- Modify in consumer: `/home/guido/peptide-admin/package.json`
- Modify in consumer: `/home/guido/peptide-admin/bun.lock`
- Modify in consumer: `/home/guido/peptide-admin/docs/NIFTIPAY.md`

**Interfaces:**
- Consumes: the tested provider behavior from Task 2.
- Produces: a Git-pinned plugin build deployed through the backend's existing `main` workflow.

- [ ] **Step 1: Update refund documentation**

Document that explicit refunds perform a read-only public-ID/key preflight, validate the integration/currency/cart and PSP record, and send only one POST using the canonical order key. State that a missing PSP record is an upstream/manual-review condition, not something Medusa can synthesize.

- [ ] **Step 2: Run the complete plugin validation**

Run:

```bash
bun run typecheck
bun test
bun run build
```

Expected: typecheck succeeds, every Bun test passes, and `.medusa/server` is regenerated.

- [ ] **Step 3: Review generated output and commit the plugin**

Run `git diff --check`, review source/tests/docs/generated output, force-add `.medusa/server`, and commit with `fix: validate Niftipay refund targets`.

- [ ] **Step 4: Push the plugin and pin the consumer**

Push the plugin commit to `dvgui/medusa-niftipay`, then update the backend Git dependency to that exact seven-character SHA and run `bun install` so `bun.lock` resolves the same commit.

- [ ] **Step 5: Validate and deploy the consumer**

Run the Niftipay unit tests and `npm run build` in a clean backend `main` worktree, commit the pin/docs update, and push `origin/main`. Verify the GitHub deployment and production service health without issuing a refund.

- [ ] **Step 6: Perform the next real-customer test operationally**

On the next legitimate refund request, confirm the order's payment provider is `pp_niftipay_niftipay`, submit the intended partial/full amount once from Medusa Admin, then verify one Medusa refund record and the matching Niftipay refund. If the preflight reports a missing PSP record, stop and give Niftipay support the public order UUID and internal key; do not retry the mutation blindly.
