import { describe, expect, it, mock } from "bun:test"
import { PaymentWebhookEvents } from "@medusajs/framework/utils"

import { NIFTIPAY_PROVIDER_ID } from "../../../constants"
import { POST } from "./route"

describe("POST /niftipay/webhook", () => {
  it("queues the exact signed body through Medusa's payment webhook event", async () => {
    const emit = mock(async () => undefined)
    const logger = { error: mock(() => undefined) }
    const rawBody = Buffer.from('{"event":"paid"}')
    const scope = {
      resolve: mock((key: string) => {
        if (key === "logger") return logger
        if (key === "payment") {
          return { options: { webhook_delay: 250, webhook_retries: 5 } }
        }
        if (key === "event_bus") return { emit }
        throw new Error(`unexpected dependency: ${key}`)
      }),
    }
    const req = {
      scope,
      rawBody,
      body: { event: "paid" },
      headers: { "x-signature": "v1=test" },
    }
    const sendStatus = mock(() => undefined)
    const json = mock(() => undefined)
    const status = mock(() => ({ json }))

    await POST(req as never, { sendStatus, status, json } as never)

    expect(emit).toHaveBeenCalledWith(
      {
        name: PaymentWebhookEvents.WebhookReceived,
        data: {
          provider: NIFTIPAY_PROVIDER_ID,
          payload: {
            data: req.body,
            rawData: rawBody,
            headers: req.headers,
          },
        },
      },
      { delay: 250, attempts: 5 },
    )
    expect(status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith({ ok: true })
  })

  it("refuses to queue a webhook when raw bytes are unavailable", async () => {
    const emit = mock(async () => undefined)
    const logger = { error: mock(() => undefined) }
    const scope = {
      resolve: mock((key: string) =>
        key === "logger" ? logger : { emit },
      ),
    }
    const json = mock(() => undefined)
    const status = mock(() => ({ json }))

    await POST(
      { scope, body: {}, headers: {} } as never,
      { status, json } as never,
    )

    expect(emit).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith({
      ok: false,
      error: "raw body unavailable",
    })
  })
})
