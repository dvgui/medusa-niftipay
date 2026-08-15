import { describe, expect, it } from "bun:test"

import { normalizeNiftipayWebhook } from "./normalize"

describe("normalizeNiftipayWebhook", () => {
  it("preserves the fiat integration ID used for project routing", () => {
    expect(
      normalizeNiftipayWebhook({
        event: "pending",
        order: {
          id: "fiat-order-id",
          integrationId: "peppys-integration-id",
          merchantReference: "payses_01M00JVM2YDY19TTT5D7FRGGHA",
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
        reference: undefined,
      },
    })
  })
})
