import {
  afterEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test"
import { PaymentActions } from "@medusajs/framework/utils"

import { signNiftipayWebhook } from "../../lib/niftipay-client/webhook"
import NiftipayPaymentProviderService from "./service"

const secret = "niftipay-test-secret-at-least-32-chars"
const sessionId = "payses_01M00JVM2YDY19TTT5D7FRGGHA"
const cartId = "cart_01M00JTNERMHY7Q4BS2XZSW4KZ"
const orderId = "3f71d8b4-2151-4a01-9346-4a1c1ca1d650"
const originalFetch = globalThis.fetch

const logger = () => ({
  debug: mock(() => undefined),
  info: mock(() => undefined),
  warn: mock(() => undefined),
  error: mock(() => undefined),
})

const options = {
  apiKey: "test-api-key",
  integrationId: "test-integration-id",
  webhookSecret: secret,
  returnUrl: "https://store.example/payment-return/{cart_id}",
  failureUrl: "https://store.example/payment-failed/{cart_id}",
  descriptionTemplate: "Medusa {brand_slug} cart {cart_id}",
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("Niftipay payment initiation", () => {
  it("sends every supported lookup field without leaking the webhook secret", async () => {
    const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = []
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input, init })
        return new Response(
          JSON.stringify({
            order: {
              id: orderId,
              orderKey: 33351,
              status: "new",
            },
            payUrl: `https://www.niftipay.com/paylink/${orderId}`,
            reference: sessionId,
          }),
          { status: 201 },
        )
      },
    ) as unknown as typeof fetch

    const service = new NiftipayPaymentProviderService(
      { logger: logger() } as never,
      options,
    )
    const result = await service.initiatePayment({
      amount: 10,
      currency_code: "gbp",
      context: { customer: { email: "customer@example.com" } },
      data: {
        session_id: sessionId,
        cart_id: cartId,
        brand_slug: "buyreta_uk",
      },
    } as never)

    expect(requests).toHaveLength(1)
    const request = requests[0]
    const body = JSON.parse(String(request.init?.body)) as Record<string, unknown>
    expect(body).toEqual({
      integrationId: "test-integration-id",
      currency: "GBP",
      amount: 10,
      email: "customer@example.com",
      description: `Medusa buyreta_uk cart ${cartId}`,
      reference: sessionId,
      merchantReference: sessionId,
      serviceFeePayer: "merchant",
      returnUrl: `https://store.example/payment-return/${cartId}`,
      failureUrl: `https://store.example/payment-failed/${cartId}`,
    })
    expect(body).not.toHaveProperty("webhookSecret")
    expect(request.init?.headers).toEqual(
      expect.objectContaining({ "x-api-key": "test-api-key" }),
    )
    expect(request.init?.headers).not.toEqual(
      expect.objectContaining({ Authorization: expect.anything() }),
    )
    expect(result.data).toEqual(
      expect.objectContaining({
        niftipay_order_id: orderId,
        niftipay_order_key: "33351",
        niftipay_reference: sessionId,
        niftipay_email: "customer@example.com",
      }),
    )
  })

  it("uses Niftipay's partial-refund endpoint and minor units", async () => {
    const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = []
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input, init })
        return new Response(JSON.stringify({ ok: true }), { status: 201 })
      },
    ) as unknown as typeof fetch

    const service = new NiftipayPaymentProviderService(
      { logger: logger() } as never,
      options,
    )
    await service.refundPayment({
      amount: 2.5,
      data: {
        session_id: sessionId,
        niftipay_order_key: "33351",
        niftipay_currency: "GBP",
      },
    } as never)

    expect(String(requests[0].input)).toEndWith(
      "/api/fiat/orders/33351/refunds",
    )
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      amountCents: 250,
      description: `Medusa refund for ${sessionId}`,
    })
  })
})

const buildWebhookService = (storedOrderId?: string) => {
  const update = mock(async () => undefined)
  const testLogger = logger()
  const paymentSessionService = {
    retrieve: mock(async () => ({
      id: sessionId,
      status: "pending",
      amount: 10,
      currency_code: "gbp",
      provider_id: "pp_niftipay_niftipay",
      data: {
        session_id: sessionId,
        niftipay_order_key: "33351",
        niftipay_reference: sessionId,
        niftipay_currency: "GBP",
        ...(storedOrderId
          ? { niftipay_order_id: storedOrderId }
          : {}),
      },
    })),
    update,
  }
  const service = new NiftipayPaymentProviderService(
    { logger: testLogger, paymentSessionService } as never,
    options,
  )
  return { logger: testLogger, service, update }
}

const signedPayload = (id = orderId) => {
  const data = {
    event: "paid",
    order: {
      id,
      currency: "GBP",
      amountCents: 1000,
      subtotalCents: 1000,
      status: "completed",
      merchantReference: sessionId,
    },
  }
  const rawData = JSON.stringify(data)
  const timestamp = String(Math.floor(Date.now() / 1000))
  return {
    data,
    rawData,
    headers: {
      "x-timestamp": timestamp,
      "x-signature": `v1=${signNiftipayWebhook(timestamp, rawData, secret)}`,
    },
  }
}

describe("Niftipay fiat webhooks", () => {
  it("accepts the documented paid payload without an internal orderKey", async () => {
    const { service, update } = buildWebhookService()
    const result = await service.getWebhookActionAndData(
      signedPayload() as never,
    )

    expect(result.action).toBe(PaymentActions.SUCCESSFUL)
    expect(result.data.session_id).toBe(sessionId)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: sessionId,
        data: expect.objectContaining({
          niftipay_order_id: orderId,
          niftipay_status: "paid",
        }),
      }),
    )
  })

  it("rejects a public order ID that does not match the stored order", async () => {
    const { logger: testLogger, service, update } =
      buildWebhookService(orderId)
    const result = await service.getWebhookActionAndData(
      signedPayload("different-fiat-order") as never,
    )

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED)
    expect(update).not.toHaveBeenCalled()
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("public order ID mismatch"),
    )
  })
})
