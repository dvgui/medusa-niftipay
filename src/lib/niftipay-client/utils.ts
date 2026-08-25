export type UnknownRecord = Record<string, unknown>

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const optionalString = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.trim() || undefined
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * Coerce a value to a finite number, understanding Medusa's BigNumber shapes.
 *
 * Medusa hands money amounts to providers as `BigNumberInput`. A BigNumber
 * INSTANCE survives `Number()` through its `valueOf()`, but the payment module
 * passes `refund.raw_amount` / `capture.raw_amount` — the plain
 * `{ value, precision }` row shape, which `Number()` turns into NaN. Treating
 * that as "no amount given" made every admin refund fail with
 * "Niftipay refund amount and currency are required".
 */
export const optionalNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined
  }

  if (isRecord(value)) {
    // Medusa BigNumber instance.
    if (typeof value.numeric === "number" && Number.isFinite(value.numeric)) {
      return value.numeric
    }
    // Raw { value, precision } row shape.
    if ("value" in value) return optionalNumber(value.value)
  }

  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const responseMessage = (body: unknown, fallback: string): string => {
  if (!isRecord(body)) return fallback
  return optionalString(body.error) ?? optionalString(body.message) ?? fallback
}
