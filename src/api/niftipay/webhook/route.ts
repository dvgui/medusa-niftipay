import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { IEventBusModuleService } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentWebhookEvents,
} from "@medusajs/framework/utils"

import { NIFTIPAY_PROVIDER_ID } from "../../../constants"

type RawBodyRequest = MedusaRequest & {
  rawBody?: Buffer | string
}

/**
 * Niftipay appends `/niftipay/webhook` to the base origin entered in its
 * dashboard. This adapter preserves its signed bytes and emits the same event
 * as Medusa's built-in `/hooks/payment/:provider` route.
 */
export async function POST(
  req: RawBodyRequest,
  res: MedusaResponse,
): Promise<void> {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const rawData = req.rawBody
  if (!rawData) {
    logger.error(
      "[niftipay] raw webhook body unavailable; signature verification cannot run",
    )
    res.status(500).json({ ok: false, error: "raw body unavailable" })
    return
  }

  try {
    const paymentModule = req.scope.resolve(Modules.PAYMENT) as {
      options?: { webhook_delay?: number; webhook_retries?: number }
    }
    const eventBus = req.scope.resolve<IEventBusModuleService>(
      Modules.EVENT_BUS,
    )
    const options = paymentModule.options ?? {}

    await eventBus.emit(
      {
        name: PaymentWebhookEvents.WebhookReceived,
        data: {
          provider: NIFTIPAY_PROVIDER_ID,
          payload: {
            data: req.body,
            rawData,
            headers: req.headers,
          },
        },
      },
      {
        delay: options.webhook_delay ?? 5_000,
        attempts: options.webhook_retries ?? 3,
      },
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`[niftipay] failed to queue webhook: ${message}`)
    res.status(400).json({ ok: false, error: "webhook not queued" })
    return
  }

  res.status(200).json({ ok: true })
}
