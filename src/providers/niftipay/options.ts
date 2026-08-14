import { MedusaError } from "@medusajs/framework/utils"

import type { NiftipayServiceFeePayer } from "../../lib/niftipay-client/types"
import { optionalString } from "../../lib/niftipay-client/utils"

export type NiftipayBrandSettings = Readonly<{
  returnUrl?: string
  failureUrl?: string
  descriptionTemplate?: string
}>

export type NiftipayProviderOptions = Readonly<{
  apiKey: string
  integrationId: string
  webhookSecret: string
  baseUrl?: string
  returnUrl?: string
  failureUrl?: string
  descriptionTemplate?: string
  brandSettings?: Readonly<Record<string, NiftipayBrandSettings>>
  serviceFeePayer?: NiftipayServiceFeePayer
  allowedCurrencies?: readonly string[]
  allowedRedirectHosts?: readonly string[]
  webhookToleranceSeconds?: number
  allowLegacyWebhookAuth?: boolean
  verifiedTtlMs?: number
}>

export type ResolvedNiftipayOptions = NiftipayProviderOptions &
  Required<
    Pick<
      NiftipayProviderOptions,
      | "baseUrl"
      | "descriptionTemplate"
      | "serviceFeePayer"
      | "webhookToleranceSeconds"
      | "allowLegacyWebhookAuth"
      | "verifiedTtlMs"
    >
  >

const DEFAULTS = {
  baseUrl: "https://www.niftipay.com",
  descriptionTemplate: "Medusa cart {cart_id}",
  serviceFeePayer: "merchant",
  webhookToleranceSeconds: 300,
  allowLegacyWebhookAuth: false,
  verifiedTtlMs: 15 * 60_000,
} as const satisfies Pick<
  ResolvedNiftipayOptions,
  | "baseUrl"
  | "descriptionTemplate"
  | "serviceFeePayer"
  | "webhookToleranceSeconds"
  | "allowLegacyWebhookAuth"
  | "verifiedTtlMs"
>

export const withDefaults = (
  options: NiftipayProviderOptions,
): ResolvedNiftipayOptions => ({
  ...DEFAULTS,
  ...options,
  baseUrl: options.baseUrl ?? DEFAULTS.baseUrl,
  descriptionTemplate:
    options.descriptionTemplate ?? DEFAULTS.descriptionTemplate,
  serviceFeePayer: options.serviceFeePayer ?? DEFAULTS.serviceFeePayer,
  webhookToleranceSeconds:
    options.webhookToleranceSeconds ?? DEFAULTS.webhookToleranceSeconds,
  allowLegacyWebhookAuth:
    options.allowLegacyWebhookAuth ?? DEFAULTS.allowLegacyWebhookAuth,
  verifiedTtlMs: options.verifiedTtlMs ?? DEFAULTS.verifiedTtlMs,
})

export const validateNiftipayOptions = (
  options: Record<string, unknown>,
): void => {
  for (const key of ["apiKey", "integrationId", "webhookSecret"] as const) {
    if (!optionalString(options[key])) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Niftipay ${key} is required when the provider is enabled`,
      )
    }
  }

  const secret = optionalString(options.webhookSecret) ?? ""
  if (secret.length < 32) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Niftipay webhookSecret must contain at least 32 characters",
    )
  }
}
