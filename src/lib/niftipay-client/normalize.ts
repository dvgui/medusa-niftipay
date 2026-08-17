import {
  NIFTIPAY_PAYMENT_EVENTS,
  type NiftipayPaymentEvent,
  type NiftipayRemoteOrder,
  type NormalizedNiftipayWebhook,
} from "./types"
import {
  isRecord,
  optionalNumber,
  optionalString,
} from "./utils"

const isPaymentEvent = (value: string): value is NiftipayPaymentEvent =>
  (NIFTIPAY_PAYMENT_EVENTS as readonly string[]).includes(value)

export const normalizeNiftipayOrder = (
  value: unknown,
): NiftipayRemoteOrder => {
  if (!isRecord(value)) return {}
  return {
    id: optionalString(value.id),
    integrationId: optionalString(value.integrationId),
    orderKey:
      optionalString(value.orderKey) ?? optionalString(value.order_key),
    merchantReference: optionalString(value.merchantReference),
    status: optionalString(value.status)?.toLowerCase(),
    currency: optionalString(value.currency)?.toUpperCase(),
    amountCents: optionalNumber(value.amountCents),
    subtotalCents: optionalNumber(value.subtotalCents),
    serviceFeePayer: optionalString(value.serviceFeePayer),
    email: optionalString(value.email),
    completedAt: optionalString(value.completedAt),
    updatedAt: optionalString(value.updatedAt),
  }
}

export const normalizeNiftipayWebhook = (
  value: unknown,
): NormalizedNiftipayWebhook => {
  if (!isRecord(value)) {
    return { kind: "unsupported", reason: "missing_event" }
  }

  const rawEvent = optionalString(value.event) ?? optionalString(value.type)
  const event = rawEvent?.toLowerCase()
  if (!event) return { kind: "unsupported", reason: "missing_event" }

  if (event === "risk_alert") {
    const alert = isRecord(value.alert) ? value.alert : {}
    const order = isRecord(value.order) ? value.order : {}
    return {
      kind: "risk_alert",
      integrationId:
        optionalString(alert.integrationId) ??
        optionalString(order.integrationId),
      merchantReference:
        optionalString(alert.merchantReference) ??
        optionalString(order.merchantReference),
    }
  }

  if (!isPaymentEvent(event)) {
    return { kind: "unsupported", event, reason: "unknown_event" }
  }
  if (!isRecord(value.order)) {
    return { kind: "unsupported", event, reason: "missing_order" }
  }

  const order = normalizeNiftipayOrder(value.order)
  const pricing = isRecord(value.pricing) ? value.pricing : {}
  return {
    kind: "payment",
    event,
    order: {
      ...order,
      reference: optionalString(value.order.reference),
      subtotalCents:
        order.subtotalCents ?? optionalNumber(pricing.subtotalCents),
    },
  }
}
