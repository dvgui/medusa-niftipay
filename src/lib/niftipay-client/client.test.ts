import { describe, expect, it } from "bun:test"

import { parseCreatedNiftipayOrder } from "./client"

describe("parseCreatedNiftipayOrder", () => {
  it("accepts Niftipay's documented nested order response", () => {
    expect(
      parseCreatedNiftipayOrder(
        {
          order: {
            id: "fiat-order-123",
            orderKey: 123,
            status: "new",
          },
          payUrl: "https://www.niftipay.com/paylink/fiat-order-123",
          reference: "payses_123",
        },
        ["niftipay.com"],
      ),
    ).toEqual({
      orderId: "fiat-order-123",
      orderKey: "123",
      payUrl: "https://www.niftipay.com/paylink/fiat-order-123",
      reference: "payses_123",
      status: "new",
    })
  })

  it("accepts the WooCommerce-compatible orderUrl response", () => {
    expect(
      parseCreatedNiftipayOrder({
        order: {
          id: "fiat-order-123",
          orderKey: 123,
          orderUrl: "https://checkout.niftipay.com/pay/123",
        },
      }),
    ).toMatchObject({ orderId: "fiat-order-123", orderKey: "123" })
  })

  it.each([
    {
      response: {
        order: { id: "id", orderKey: "1" },
        payUrl: "http://www.niftipay.com/pay/1",
      },
      hosts: [] as string[],
    },
    {
      response: {
        order: { id: "id", orderKey: "1" },
        payUrl: "https://attacker.example/pay/1",
      },
      hosts: ["niftipay.com"],
    },
  ])("rejects an unsafe redirect", ({ response, hosts }) => {
    expect(() => parseCreatedNiftipayOrder(response, hosts)).toThrow()
  })

  it("requires the public order ID used by fiat webhooks", () => {
    expect(() =>
      parseCreatedNiftipayOrder({
        order: { orderKey: "1" },
        payUrl: "https://www.niftipay.com/pay/1",
      }),
    ).toThrow("order.id")
  })
})
