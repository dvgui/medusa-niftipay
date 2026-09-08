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

/**
 * Why a webhook failed authentication. Every rejection used to collapse to a
 * bare `false`, which made a rejected webhook impossible to triage from the
 * logs: a stale retry, an unsigned legacy delivery and a genuinely wrong secret
 * all looked identical. Callers log this.
 */
export type NiftipayWebhookAuthFailure =
  | "malformed_signature_headers"
  | "timestamp_outside_tolerance"
  | "signature_mismatch"
  | "unsigned_and_legacy_disabled"
  | "legacy_secret_missing"
  | "legacy_secret_mismatch"

export type NiftipayWebhookAuthResult =
  | { ok: true }
  | { ok: false; reason: NiftipayWebhookAuthFailure; detail?: string }

export const verifyNiftipayWebhookDetailed = ({
  rawBody,
  headers,
  data,
  options,
}: {
  rawBody: string
  headers: Record<string, unknown>
  data: unknown
  options: NiftipayWebhookAuthOptions
}): NiftipayWebhookAuthResult => {
  const timestamp = headerValue(headers, "x-timestamp")
  const signature = headerValue(headers, "x-signature")

  if (timestamp || signature) {
    if (
      !timestamp ||
      !signature?.startsWith("v1=") ||
      !/^\d{9,12}$/.test(timestamp)
    ) {
      return { ok: false, reason: "malformed_signature_headers" }
    }

    const timestampSeconds = Number(timestamp)
    const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
    const skew = Math.abs(nowSeconds - timestampSeconds)
    if (!Number.isFinite(timestampSeconds) || skew > options.toleranceSeconds) {
      return {
        ok: false,
        reason: "timestamp_outside_tolerance",
        // A retry of an older delivery lands here; the skew says how stale.
        detail: `skew=${skew}s tolerance=${options.toleranceSeconds}s`,
      }
    }

    return timingSafeHexEqual(
      signature.slice(3),
      signNiftipayWebhook(timestamp, rawBody, options.secret),
    )
      ? { ok: true }
      : { ok: false, reason: "signature_mismatch" }
  }

  if (!options.allowLegacy) {
    return { ok: false, reason: "unsigned_and_legacy_disabled" }
  }

  const headerSecret = headerValue(headers, "x-webhook-secret")
  const bodySecret = isRecord(data)
    ? optionalString(data.webhookSecret)
    : undefined
  const supplied = headerSecret ?? bodySecret
  if (!supplied) return { ok: false, reason: "legacy_secret_missing" }

  const suppliedBytes = Buffer.from(supplied, "utf8")
  const expectedBytes = Buffer.from(options.secret, "utf8")
  return suppliedBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(suppliedBytes, expectedBytes)
    ? { ok: true }
    : { ok: false, reason: "legacy_secret_mismatch" }
}

/** Boolean form, preserved for existing callers. */
export const verifyNiftipayWebhook = (input: {
  rawBody: string
  headers: Record<string, unknown>
  data: unknown
  options: NiftipayWebhookAuthOptions
}): boolean => verifyNiftipayWebhookDetailed(input).ok
