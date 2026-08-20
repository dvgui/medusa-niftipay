export const NIFTIPAY_PAYMENT_EVENTS = [
  "paid",
  "pending",
  "underpaid",
  "cancelled",
  "expired",
  "refunded",
  "chargeback",
] as const

export type NiftipayPaymentEvent =
  (typeof NIFTIPAY_PAYMENT_EVENTS)[number]

export type NiftipayServiceFeePayer = "customer" | "merchant"

type FiatOrderAmount =
  | Readonly<{ amount: number; amountCents?: never }>
  | Readonly<{ amount?: never; amountCents: number }>

export type NiftipayFiatOrderPayload = Readonly<{
  integrationId: string
  currency: string
  description?: string
  reference?: string
  merchantReference?: string
  serviceFeePayer?: NiftipayServiceFeePayer
  email?: string
  returnUrl?: string
  failureUrl?: string
}> &
  FiatOrderAmount

export type NiftipayCreatedOrder = Readonly<{
  orderId: string
  orderKey: string
  payUrl: string
  status?: string
  reference?: string
}>

export type NiftipayRemoteOrder = Readonly<{
  id?: string
  integrationId?: string
  orderKey?: string
  merchantReference?: string
  status?: string
  currency?: string
  amountCents?: number
  subtotalCents?: number
  serviceFeePayer?: string
  email?: string
  pspOrderId?: string
  pspStatus?: string
  pspTransactionCount?: number
  completedAt?: string
  updatedAt?: string
}>

export type NiftipayWebhookOrder = NiftipayRemoteOrder &
  Readonly<{ reference?: string }>

export type NormalizedNiftipayWebhook =
  | Readonly<{
      kind: "payment"
      event: NiftipayPaymentEvent
      order: NiftipayWebhookOrder
    }>
  | Readonly<{
      kind: "risk_alert"
      integrationId?: string
      merchantReference?: string
    }>
  | Readonly<{
      kind: "unsupported"
      event?: string
      reason: "missing_event" | "missing_order" | "unknown_event"
    }>

export type NiftipayClientOptions = Readonly<{
  apiKey: string
  baseUrl?: string
  allowedRedirectHosts?: readonly string[]
  timeoutMs?: number
}>

export type NiftipayRefundPayload = Readonly<{
  amountCents: number
  description?: string
}>
