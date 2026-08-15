import { describe, expect, it } from "bun:test"

import {
  resolveNiftipayCredentialsForBrand,
  resolveNiftipayCredentialsForIntegration,
  validateNiftipayOptions,
} from "./options"

const defaultSecret = "default-secret-with-at-least-32-characters"
const peppysSecret = "peppys-secret-with-at-least-32-characters"
const options = {
  apiKey: "api-key",
  integrationId: "default-integration",
  webhookSecret: defaultSecret,
  brandSettings: {
    peppys_uk: {
      integrationId: "peppys-integration",
      webhookSecret: peppysSecret,
    },
  },
}

describe("Niftipay credential resolution", () => {
  it("resolves outbound credentials by store and inbound credentials by integration", () => {
    expect(resolveNiftipayCredentialsForBrand(options, "peppys_uk")).toEqual({
      integrationId: "peppys-integration",
      webhookSecret: peppysSecret,
      brandSlug: "peppys_uk",
    })
    expect(
      resolveNiftipayCredentialsForIntegration(
        options,
        "peppys-integration",
      ),
    ).toEqual({
      integrationId: "peppys-integration",
      webhookSecret: peppysSecret,
      brandSlug: "peppys_uk",
    })
  })

  it("rejects one integration ID being assigned to multiple stores", () => {
    expect(() =>
      validateNiftipayOptions({
        ...options,
        brandSettings: {
          peppys_uk: options.brandSettings.peppys_uk,
          another_store: {
            integrationId: "peppys-integration",
            webhookSecret: peppysSecret,
          },
        },
      }),
    ).toThrow("integrationId must be unique per store")
  })
})
