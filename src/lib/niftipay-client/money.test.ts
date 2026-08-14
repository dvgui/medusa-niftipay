import { describe, expect, it } from "bun:test"

import { currencyMinorUnits, toMinorUnits } from "./money"

describe("Niftipay ISO 4217 minor units", () => {
  it.each([
    ["GBP", 2],
    ["JPY", 0],
    ["BHD", 3],
  ])("uses the correct precision for %s", (currency, digits) => {
    expect(currencyMinorUnits(currency)).toBe(digits)
  })

  it.each([
    [19.95, "GBP", 1995],
    [500, "JPY", 500],
    [1.234, "BHD", 1234],
  ])("converts %s %s to minor units", (amount, currency, expected) => {
    expect(toMinorUnits(amount, currency)).toBe(expected)
  })

  it("rejects precision that the currency cannot represent", () => {
    expect(() => toMinorUnits(1.01, "JPY")).toThrow()
  })
})
