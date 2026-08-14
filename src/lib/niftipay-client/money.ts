export const currencyMinorUnits = (currency: string): number => {
  const normalized = currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(`Invalid ISO 4217 currency code: ${currency}`)
  }

  return (
    new Intl.NumberFormat("en", {
      style: "currency",
      currency: normalized,
    }).resolvedOptions().maximumFractionDigits ?? 2
  )
}

/**
 * Convert Medusa's major-unit amount (for example 19.95 GBP) to Niftipay's
 * minor-unit field. `Intl` supplies ISO 4217's 0/2/3-decimal currency rules.
 */
export const toMinorUnits = (amount: number, currency: string): number => {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Payment amount must be a positive finite number")
  }
  const scale = 10 ** currencyMinorUnits(currency)
  const scaled = amount * scale
  const rounded = Math.round(scaled)
  if (Math.abs(scaled - rounded) > 1e-7) {
    throw new Error(`${amount} has too many decimal places for ${currency}`)
  }
  return rounded
}
