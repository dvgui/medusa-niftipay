import { describe, expect, it } from "bun:test"

import { normalizeNiftipayWebhook } from "./normalize"
import {
  signNiftipayWebhook,
  verifyNiftipayWebhook,
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
