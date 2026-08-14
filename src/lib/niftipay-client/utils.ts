export type UnknownRecord = Record<string, unknown>

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const optionalString = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.trim() || undefined
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

export const optionalNumber = (value: unknown): number | undefined => {
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const responseMessage = (body: unknown, fallback: string): string => {
  if (!isRecord(body)) return fallback
  return optionalString(body.error) ?? optionalString(body.message) ?? fallback
}
