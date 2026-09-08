import { describe, expect, it } from "bun:test"

import { normalizeNiftipayWebhook } from "./normalize"
import {
  signNiftipayWebhook,
  verifyNiftipayWebhook,
  verifyNiftipayWebhookDetailed,
} from "./webhook"

const secret = "niftipay-test-secret-at-least-32-chars"
const now = 1_800_000_000_000
const timestamp = String(Math.floor(now / 1000))
const rawBody = JSON.stringify({
  event: "paid",
  order: { id: "fiat-order-42" },
})

describe("Niftipay webhook authentication", () => {
  it("accepts a current v1 HMAC over the exact raw body", () => {
    expect(
      verifyNiftipayWebhook({
        rawBody,
        headers: {
          "x-timestamp": timestamp,
          "x-signature": `v1=${signNiftipayWebhook(timestamp, rawBody, secret)}`,
        },
        data: JSON.parse(rawBody),
        options: { secret, toleranceSeconds: 300, allowLegacy: false, now },
      }),
    ).toBe(true)
  })

  it("rejects an unversioned signature", () => {
    expect(
      verifyNiftipayWebhook({
        rawBody,
        headers: {
          "x-timestamp": timestamp,
          "x-signature": signNiftipayWebhook(timestamp, rawBody, secret),
        },
        data: JSON.parse(rawBody),
        options: { secret, toleranceSeconds: 300, allowLegacy: false, now },
      }),
    ).toBe(false)
  })

  it.each([
    { name: "tampered body", body: `${rawBody} `, at: now },
    { name: "expired timestamp", body: rawBody, at: now + 301_000 },
  ])("rejects a $name", ({ body, at }) => {
    expect(
      verifyNiftipayWebhook({
        rawBody: body,
        headers: {
          "x-timestamp": timestamp,
          "x-signature": `v1=${signNiftipayWebhook(timestamp, rawBody, secret)}`,
        },
        data: JSON.parse(rawBody),
        options: { secret, toleranceSeconds: 300, allowLegacy: false, now: at },
      }),
    ).toBe(false)
  })
})

describe("Niftipay webhook normalization", () => {
  it("normalizes the documented fiat paid event without an orderKey", () => {
    expect(
      normalizeNiftipayWebhook({
        event: "PAID",
        order: {
          id: "fiat-order-42",
          merchantReference: "payses_123",
          currency: "gbp",
          amountCents: "1299",
        },
        pricing: { subtotalCents: "1200" },
      }),
    ).toEqual({
      kind: "payment",
      event: "paid",
      order: {
        id: "fiat-order-42",
        orderKey: undefined,
        merchantReference: "payses_123",
        status: undefined,
        currency: "GBP",
        amountCents: 1299,
        subtotalCents: 1200,
        serviceFeePayer: undefined,
        reference: undefined,
      },
    })
  })
})

describe("Niftipay webhook rejection reasons", () => {
  const detailed = (
    headers: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
    body = rawBody
  ) =>
    verifyNiftipayWebhookDetailed({
      rawBody: body,
      headers,
      data: JSON.parse(body),
      options: {
        secret,
        toleranceSeconds: 300,
        allowLegacy: false,
        now,
        ...overrides,
      },
    })

  const signedHeaders = (ts = timestamp) => ({
    "x-timestamp": ts,
    "x-signature": `v1=${signNiftipayWebhook(ts, rawBody, secret)}`,
  })

  it("reports ok for a valid signature", () => {
    expect(detailed(signedHeaders())).toEqual({ ok: true })
  })

  it("distinguishes a stale retry from a bad secret", () => {
    // A webhook RETRY carries the original timestamp, so it fails on skew —
    // not on the signature. Telling these apart is the whole point.
    const stale = String(Math.floor(now / 1000) - 3600)
    const result = detailed(signedHeaders(stale))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("timestamp_outside_tolerance")
      expect(result.detail).toContain("skew=3600s")
    }
  })

  it("reports signature_mismatch when the secret is wrong", () => {
    const result = detailed(
      {
        "x-timestamp": timestamp,
        "x-signature": `v1=${signNiftipayWebhook(timestamp, rawBody, "a-different-secret-value-1234567890")}`,
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("signature_mismatch")
  })

  it("reports malformed headers for an unversioned signature", () => {
    const result = detailed({
      "x-timestamp": timestamp,
      "x-signature": signNiftipayWebhook(timestamp, rawBody, secret),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("malformed_signature_headers")
  })

  it("reports an unsigned delivery when legacy auth is disabled", () => {
    const result = detailed({})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unsigned_and_legacy_disabled")
  })

  it("keeps the boolean wrapper in step with the detailed result", () => {
    const headers = signedHeaders()
    expect(
      verifyNiftipayWebhook({
        rawBody,
        headers,
        data: JSON.parse(rawBody),
        options: { secret, toleranceSeconds: 300, allowLegacy: false, now },
      }),
    ).toBe(detailed(headers).ok)
  })
})
