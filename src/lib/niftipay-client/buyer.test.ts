import { describe, expect, it } from "bun:test"
import { niftipayBuyerDetails, normalizeCountry, normalizePhoneE164 } from "./buyer"

describe("normalizePhoneE164", () => {
  it("turns a UK national number into E.164", () => {
    expect(normalizePhoneE164("07899 655783", "GB")).toBe("+447899655783")
  })
  it("keeps a number already in E.164, stripping formatting", () => {
    expect(normalizePhoneE164("+44 7777 940841", "GB")).toBe("+447777940841")
    expect(normalizePhoneE164("+34600111222", "ES")).toBe("+34600111222")
  })
  it("reads a 00 international prefix", () => {
    expect(normalizePhoneE164("0044 7899 655783", "GB")).toBe("+447899655783")
  })
  it("prefixes national numbers in countries without a trunk zero", () => {
    expect(normalizePhoneE164("600 111 222", "ES")).toBe("+34600111222")
  })
  it("drops a UK number with the wrong number of digits (a typo)", () => {
    expect(normalizePhoneE164("075493839012", "GB")).toBeUndefined()
  })
  it("drops what it can't be sure of", () => {
    expect(normalizePhoneE164("7899655783", "GB")).toBeUndefined()
    expect(normalizePhoneE164("07899655783", undefined)).toBeUndefined()
    expect(normalizePhoneE164("call me", "GB")).toBeUndefined()
    expect(normalizePhoneE164("", "GB")).toBeUndefined()
    expect(normalizePhoneE164(undefined, "GB")).toBeUndefined()
  })
})

describe("normalizeCountry", () => {
  it("accepts a 2-letter code in any case", () => {
    expect(normalizeCountry("gb")).toBe("GB")
  })
  it("rejects anything that isn't a 2-letter code", () => {
    expect(normalizeCountry("United Kingdom")).toBeUndefined()
    expect(normalizeCountry("GBR")).toBeUndefined()
    expect(normalizeCountry("")).toBeUndefined()
  })
})

describe("niftipayBuyerDetails", () => {
  const billing = { first_name: "Paula", last_name: "Larway", phone: "07899 655783", country_code: "gb" }

  it("uses the billing address", () => {
    expect(niftipayBuyerDetails({ billingAddress: billing })).toEqual({
      firstName: "Paula",
      lastName: "Larway",
      phone: "+447899655783",
      country: "GB",
    })
  })

  it("falls back to the shipping address when billing is empty", () => {
    expect(
      niftipayBuyerDetails({
        billingAddress: { first_name: "", last_name: "", phone: "", country_code: "" },
        shippingAddress: billing,
      })
    ).toEqual({ firstName: "Paula", lastName: "Larway", phone: "+447899655783", country: "GB" })
  })

  it("falls back to the customer's name when there is no address", () => {
    expect(niftipayBuyerDetails({ customerName: "Mary Ann Smith" })).toEqual({
      firstName: "Mary",
      lastName: "Ann Smith",
    })
  })

  it("omits a phone it can't normalise but keeps the rest", () => {
    expect(niftipayBuyerDetails({ billingAddress: { ...billing, phone: "075493839012" } })).toEqual({
      firstName: "Paula",
      lastName: "Larway",
      country: "GB",
    })
  })

  it("returns nothing when there is nothing to send", () => {
    expect(niftipayBuyerDetails({})).toEqual({})
  })
})
