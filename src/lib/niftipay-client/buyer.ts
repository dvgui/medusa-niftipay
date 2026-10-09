/**
 * Buyer details for a Niftipay card order (`firstName`, `lastName`, `phone`,
 * `country`). Niftipay passes them to the card processor for that transaction
 * only, where they feed fraud scoring; every field is optional, and a blank one
 * is ignored. So anything we can't express confidently is left out rather than
 * sent wrong: a wrong phone or country is worse than none.
 */

type Address = Record<string, unknown> | null | undefined

export type NiftipayBuyerDetails = Readonly<{
  firstName?: string
  lastName?: string
  phone?: string
  country?: string
}>

/** Calling codes for the countries we ship to. */
const CALLING_CODES: Readonly<Record<string, string>> = {
  GB: "44", IE: "353", FR: "33", DE: "49", ES: "34", IT: "39", NL: "31",
  BE: "32", PT: "351", AT: "43", CH: "41", SE: "46", DK: "45", NO: "47",
  FI: "358", PL: "48", CZ: "420", GR: "30", LU: "352",
}

/** Countries whose national format starts with a trunk "0" that E.164 drops. */
const TRUNK_ZERO = new Set(["GB", "IE", "FR", "DE", "NL", "BE", "AT", "CH", "SE", "FI"])

/** National significant number lengths we are sure of. */
const NATIONAL_LENGTH: Readonly<Record<string, number>> = { GB: 10 }

const E164 = /^\+[1-9]\d{7,14}$/

const text = (value: unknown, max = 100): string | undefined => {
  if (typeof value !== "string") return undefined
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  return cleaned ? cleaned.slice(0, max) : undefined
}

export const normalizeCountry = (value: unknown): string | undefined => {
  const code = text(value, 10)?.toUpperCase()
  return code && /^[A-Z]{2}$/.test(code) ? code : undefined
}

/**
 * E.164 from what a shopper typed, e.g. "07899 655783" in GB → "+447899655783".
 * Returns undefined unless the result is certain.
 */
export const normalizePhoneE164 = (value: unknown, country?: string): string | undefined => {
  const raw = text(value, 40)
  if (!raw) return undefined
  let digits = raw.replace(/[\s().\-/]/g, "")
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`

  let e164: string | undefined
  if (digits.startsWith("+")) {
    e164 = digits
  } else if (country && CALLING_CODES[country] && /^\d+$/.test(digits)) {
    const national = TRUNK_ZERO.has(country) && digits.startsWith("0") ? digits.slice(1) : digits
    if (TRUNK_ZERO.has(country) && !digits.startsWith("0")) return undefined
    e164 = `+${CALLING_CODES[country]}${national}`
  }
  if (!e164 || !E164.test(e164)) return undefined

  // Where we know the exact length, a number off by a digit is a typo: drop it.
  for (const [code, length] of Object.entries(NATIONAL_LENGTH)) {
    const prefix = `+${CALLING_CODES[code]}`
    if (e164.startsWith(prefix) && e164.length - prefix.length !== length) return undefined
  }
  return e164
}

const splitName = (full: unknown): { first?: string; last?: string } => {
  const name = text(full, 200)
  if (!name) return {}
  const [first, ...rest] = name.split(" ")
  return { first: text(first), last: text(rest.join(" ")) }
}

/**
 * Billing address first (the card processor checks the cardholder), then the
 * shipping address, then the customer's name as a last resort.
 */
export const niftipayBuyerDetails = (input: {
  billingAddress?: Address
  shippingAddress?: Address
  customerName?: unknown
  customerPhone?: unknown
}): NiftipayBuyerDetails => {
  const billing = input.billingAddress ?? undefined
  const shipping = input.shippingAddress ?? undefined
  const fromName = splitName(input.customerName)

  const billingHasName = Boolean(text(billing?.first_name) || text(billing?.last_name))
  const named = billingHasName ? billing : shipping
  const firstName = text(named?.first_name) ?? fromName.first
  const lastName = text(named?.last_name) ?? (text(named?.first_name) ? undefined : fromName.last)

  const country = normalizeCountry(billing?.country_code) ?? normalizeCountry(shipping?.country_code)

  const phone =
    normalizePhoneE164(billing?.phone, normalizeCountry(billing?.country_code) ?? country) ??
    normalizePhoneE164(shipping?.phone, normalizeCountry(shipping?.country_code) ?? country) ??
    normalizePhoneE164(input.customerPhone, country)

  return {
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(phone ? { phone } : {}),
    ...(country ? { country } : {}),
  }
}
