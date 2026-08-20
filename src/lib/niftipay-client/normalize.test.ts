import { describe, expect, it } from "bun:test"

import {
  normalizeNiftipayOrder,
  normalizeNiftipayWebhook,
} from "./normalize"

describe("normalizeNiftipayOrder", () => {
  it("preserves the PSP fields required to preflight a refund", () => {
    expect(
      normalizeNiftipayOrder({
        id: "fiat-order-id",
        orderKey: 33351,
        pspOrderId: "  processor-order-id  ",
        pspStatus: "COMPLETED",
        pspTransactionCount: "1",
      }),
    ).toMatchObject({
      id: "fiat-order-id",
      orderKey: "33351",
      pspOrderId: "processor-order-id",
      pspStatus: "completed",
      pspTransactionCount: 1,
    })
  })
})

describe("normalizeNiftipayWebhook", () => {
  it("preserves the fiat integration ID used for project routing", () => {
    expect(
      normalizeNiftipayWebhook({
        event: "pending",
        order: {
          id: "fiat-order-id",
          integrationId: "peppys-integration-id",
          merchantReference: "payses_01M00JVM2YDY19TTT5D7FRGGHA",
          email: "customer@example.com",
          completedAt: "2026-08-17T07:39:56.092Z",
        },
      }),
    ).toEqual({
      kind: "payment",
      event: "pending",
      order: {
        id: "fiat-order-id",
        integrationId: "peppys-integration-id",
        merchantReference: "payses_01M00JVM2YDY19TTT5D7FRGGHA",
        orderKey: undefined,
        status: undefined,
        currency: undefined,
        amountCents: undefined,
        subtotalCents: undefined,
        serviceFeePayer: undefined,
        email: "customer@example.com",
        completedAt: "2026-08-17T07:39:56.092Z",
        updatedAt: undefined,
        reference: undefined,
      },
    })
  })
})
