import { MedusaError } from "@medusajs/framework/utils"

import { normalizeNiftipayOrder } from "./normalize"
import type {
  NiftipayClientOptions,
  NiftipayCreatedOrder,
  NiftipayFiatOrderPayload,
  NiftipayRefundPayload,
  NiftipayRemoteOrder,
} from "./types"
import {
  isRecord,
  optionalString,
  responseMessage,
} from "./utils"

const DEFAULT_BASE_URL = "https://www.niftipay.com"
const DEFAULT_TIMEOUT_MS = 25_000

const normalizeHost = (host: string): string => host.trim().toLowerCase()

const isAllowedRedirectHost = (
  hostname: string,
  allowedHosts: readonly string[],
): boolean => {
  const candidate = normalizeHost(hostname)
  return allowedHosts.some((host) => {
    const allowed = normalizeHost(host)
    return candidate === allowed || candidate.endsWith(`.${allowed}`)
  })
}

export const parseCreatedNiftipayOrder = (
  value: unknown,
  allowedRedirectHosts: readonly string[] = [],
): NiftipayCreatedOrder => {
  if (!isRecord(value)) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Niftipay returned an invalid create-order response",
    )
  }

  const order = isRecord(value.order) ? value.order : {}
  const payUrl =
    optionalString(value.payUrl) ??
    optionalString(order.orderUrl) ??
    optionalString(order.payUrl)
  const orderKey =
    optionalString(order.orderKey) ??
    optionalString(order.order_key) ??
    optionalString(value.orderKey)
  const orderId = optionalString(order.id) ?? optionalString(value.id)

  if (!payUrl || !orderKey || !orderId) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Niftipay create-order response is missing payUrl, orderKey, or order.id",
    )
  }

  let redirect: URL
  try {
    redirect = new URL(payUrl)
  } catch {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Niftipay returned an invalid payment URL",
    )
  }

  if (redirect.protocol !== "https:") {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Niftipay payment URL must use HTTPS",
    )
  }
  if (
    allowedRedirectHosts.length > 0 &&
    !isAllowedRedirectHost(redirect.hostname, allowedRedirectHosts)
  ) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Niftipay returned a payment URL on an unapproved host",
    )
  }

  return {
    orderId,
    orderKey,
    payUrl: redirect.toString(),
    status: optionalString(order.status) ?? optionalString(value.status),
    reference:
      optionalString(value.reference) ??
      optionalString(order.merchantReference),
  }
}

export class NiftipayClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly allowedRedirectHosts: readonly string[]
  private readonly timeoutMs: number

  constructor(options: NiftipayClientOptions) {
    this.apiKey = options.apiKey.trim()
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.allowedRedirectHosts = options.allowedRedirectHosts ?? []
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const base = new URL(this.baseUrl)
    if (base.protocol !== "https:") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Niftipay base URL must use HTTPS",
      )
    }
  }

  toJSON() {
    return { baseUrl: this.baseUrl }
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "x-api-key": this.apiKey,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      })

      const raw = await response.text()
      let decoded: unknown = {}
      if (raw) {
        try {
          decoded = JSON.parse(raw)
        } catch {
          decoded = {}
        }
      }

      if (!response.ok) {
        const fallback = `Niftipay API error (HTTP ${response.status})`
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          responseMessage(decoded, fallback).slice(0, 500),
        )
      }
      return decoded
    } catch (error: unknown) {
      if (error instanceof MedusaError) throw error
      const message =
        error instanceof Error && error.name === "TimeoutError"
          ? "Niftipay API request timed out"
          : "Niftipay API request failed"
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, message)
    }
  }

  async createFiatOrder(
    payload: NiftipayFiatOrderPayload,
  ): Promise<NiftipayCreatedOrder> {
    return parseCreatedNiftipayOrder(
      await this.request("POST", "/api/fiat/orders", payload),
      this.allowedRedirectHosts,
    )
  }

  async retrieveFiatOrder(identifier: string): Promise<unknown> {
    return this.request(
      "GET",
      `/api/fiat/orders/${encodeURIComponent(identifier)}`,
    )
  }

  async retrieveNormalizedFiatOrder(
    identifier: string,
  ): Promise<NiftipayRemoteOrder> {
    const response = await this.retrieveFiatOrder(identifier)
    const envelope = isRecord(response) ? response : {}
    return normalizeNiftipayOrder(
      isRecord(envelope.order) ? envelope.order : envelope,
    )
  }

  async cancelFiatOrder(identifier: string): Promise<unknown> {
    return this.request(
      "DELETE",
      `/api/fiat/orders/${encodeURIComponent(identifier)}`,
    )
  }

  async createFiatRefund(
    identifier: string,
    payload: NiftipayRefundPayload,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/fiat/orders/${encodeURIComponent(identifier)}/refunds`,
      payload,
    )
  }
}
