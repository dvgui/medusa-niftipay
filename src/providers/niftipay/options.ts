import { MedusaError } from "@medusajs/framework/utils";

import type { NiftipayServiceFeePayer } from "../../lib/niftipay-client/types";
import { isRecord, optionalString } from "../../lib/niftipay-client/utils";

export type NiftipayBrandSettings = Readonly<{
  integrationId?: string;
  webhookSecret?: string;
  returnUrl?: string;
  failureUrl?: string;
  descriptionTemplate?: string;
}>;

export type NiftipayResolvedCredentials = Readonly<{
  integrationId: string;
  webhookSecret: string;
  brandSlug?: string;
}>;

type NiftipayCredentialOptions = Pick<
  NiftipayProviderOptions,
  "integrationId" | "webhookSecret" | "brandSettings"
>;

export type NiftipayProviderOptions = Readonly<{
  apiKey: string;
  integrationId: string;
  webhookSecret: string;
  baseUrl?: string;
  returnUrl?: string;
  failureUrl?: string;
  descriptionTemplate?: string;
  brandSettings?: Readonly<Record<string, NiftipayBrandSettings>>;
  serviceFeePayer?: NiftipayServiceFeePayer;
  allowedCurrencies?: readonly string[];
  allowedRedirectHosts?: readonly string[];
  webhookToleranceSeconds?: number;
  allowLegacyWebhookAuth?: boolean;
  verifiedTtlMs?: number;
}>;

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
  >;

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
>;

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
});

export const resolveNiftipayCredentialsForBrand = (
  options: NiftipayCredentialOptions,
  brandSlug?: string,
): NiftipayResolvedCredentials => {
  const brand = brandSlug ? options.brandSettings?.[brandSlug] : undefined;
  return {
    integrationId: brand?.integrationId ?? options.integrationId,
    webhookSecret: brand?.webhookSecret ?? options.webhookSecret,
    ...(brandSlug ? { brandSlug } : {}),
  };
};

export const resolveNiftipayCredentialsForIntegration = (
  options: NiftipayCredentialOptions,
  integrationId: string,
): NiftipayResolvedCredentials | undefined => {
  if (integrationId === options.integrationId) {
    return {
      integrationId: options.integrationId,
      webhookSecret: options.webhookSecret,
    };
  }

  for (const [brandSlug, settings] of Object.entries(
    options.brandSettings ?? {},
  )) {
    if (
      settings.integrationId === integrationId &&
      settings.webhookSecret
    ) {
      return {
        integrationId,
        webhookSecret: settings.webhookSecret,
        brandSlug,
      };
    }
  }

  return undefined;
};

export const validateNiftipayOptions = (
  options: Record<string, unknown>,
): void => {
  for (const key of ["apiKey", "integrationId", "webhookSecret"] as const) {
    if (!optionalString(options[key])) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Niftipay ${key} is required when the provider is enabled`,
      );
    }
  }

  const secret = optionalString(options.webhookSecret) ?? "";
  if (secret.length < 32) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Niftipay webhookSecret must contain at least 32 characters",
    );
  }

  const brandSettings = isRecord(options.brandSettings)
    ? options.brandSettings
    : {};
  const integrationOwners = new Map<string, string>([
    [optionalString(options.integrationId) ?? "", "default"],
  ]);
  for (const [brandSlug, candidate] of Object.entries(brandSettings)) {
    if (!isRecord(candidate)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Niftipay brandSettings.${brandSlug} must be an object`,
      );
    }

    const integrationId = optionalString(candidate.integrationId);
    const webhookSecret = optionalString(candidate.webhookSecret);
    if (Boolean(integrationId) !== Boolean(webhookSecret)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Niftipay brandSettings.${brandSlug} must configure integrationId and webhookSecret together`,
      );
    }
    if (webhookSecret && webhookSecret.length < 32) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Niftipay brandSettings.${brandSlug}.webhookSecret must contain at least 32 characters`,
      );
    }
    if (integrationId) {
      const existingOwner = integrationOwners.get(integrationId);
      if (existingOwner && existingOwner !== brandSlug) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Niftipay integrationId must be unique per store; brandSettings.${brandSlug} duplicates ${existingOwner}`,
        );
      }
      integrationOwners.set(integrationId, brandSlug);
    }
  }
};
