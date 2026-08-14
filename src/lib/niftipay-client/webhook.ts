import crypto from "node:crypto"

import { isRecord, optionalString } from "./utils"

export type NiftipayWebhookAuthOptions = Readonly<{
  secret: string
  toleranceSeconds: number
  allowLegacy: boolean
  now?: number
}>

const headerValue = (
  headers: Record<string, unknown>,
  name: string,
): string | undefined => {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1]
  const value = Array.isArray(entry) ? entry[0] : entry
  return optionalString(value)
}

const timingSafeHexEqual = (left: string, right: string): boolean => {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) {
    return false
  }
  return crypto.timingSafeEqual(
    Buffer.from(left.toLowerCase(), "hex"),
    Buffer.from(right.toLowerCase(), "hex"),
  )
}

export const signNiftipayWebhook = (
  timestamp: string,
  rawBody: string,
  secret: string,
): string =>
  crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex")

export const verifyNiftipayWebhook = ({
  rawBody,
  headers,
  data,
  options,
}: {
  rawBody: string
  headers: Record<string, unknown>
  data: unknown
  options: NiftipayWebhookAuthOptions
}): boolean => {
  const timestamp = headerValue(headers, "x-timestamp")
  const signature = headerValue(headers, "x-signature")

  if (timestamp || signature) {
    if (
      !timestamp ||
      !signature?.startsWith("v1=") ||
      !/^\d{9,12}$/.test(timestamp)
    ) {
      return false
    }

    const timestampSeconds = Number(timestamp)
    const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
    if (
      !Number.isFinite(timestampSeconds) ||
      Math.abs(nowSeconds - timestampSeconds) > options.toleranceSeconds
    ) {
      return false
    }

    return timingSafeHexEqual(
      signature.slice(3),
      signNiftipayWebhook(timestamp, rawBody, options.secret),
    )
  }

  if (!options.allowLegacy) return false

  const headerSecret = headerValue(headers, "x-webhook-secret")
  const bodySecret = isRecord(data)
    ? optionalString(data.webhookSecret)
    : undefined
  const supplied = headerSecret ?? bodySecret
  if (!supplied) return false

  const suppliedBytes = Buffer.from(supplied, "utf8")
  const expectedBytes = Buffer.from(options.secret, "utf8")
  return (
    suppliedBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(suppliedBytes, expectedBytes)
  )
}
