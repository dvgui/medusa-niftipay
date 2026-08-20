"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateNiftipayOptions = exports.resolveNiftipayCredentialsForIntegration = exports.resolveNiftipayCredentialsForBrand = exports.withDefaults = void 0;
const utils_1 = require("@medusajs/framework/utils");
const utils_2 = require("../../lib/niftipay-client/utils");
const DEFAULTS = {
    baseUrl: "https://www.niftipay.com",
    descriptionTemplate: "Medusa cart {cart_id}",
    serviceFeePayer: "merchant",
    webhookToleranceSeconds: 300,
    allowLegacyWebhookAuth: false,
    verifiedTtlMs: 15 * 60_000,
};
const withDefaults = (options) => ({
    ...DEFAULTS,
    ...options,
    baseUrl: options.baseUrl ?? DEFAULTS.baseUrl,
    descriptionTemplate: options.descriptionTemplate ?? DEFAULTS.descriptionTemplate,
    serviceFeePayer: options.serviceFeePayer ?? DEFAULTS.serviceFeePayer,
    webhookToleranceSeconds: options.webhookToleranceSeconds ?? DEFAULTS.webhookToleranceSeconds,
    allowLegacyWebhookAuth: options.allowLegacyWebhookAuth ?? DEFAULTS.allowLegacyWebhookAuth,
    verifiedTtlMs: options.verifiedTtlMs ?? DEFAULTS.verifiedTtlMs,
});
exports.withDefaults = withDefaults;
const resolveNiftipayCredentialsForBrand = (options, brandSlug) => {
    const brand = brandSlug ? options.brandSettings?.[brandSlug] : undefined;
    return {
        apiKey: brand?.apiKey ?? options.apiKey,
        integrationId: brand?.integrationId ?? options.integrationId,
        webhookSecret: brand?.webhookSecret ?? options.webhookSecret,
        ...(brandSlug ? { brandSlug } : {}),
    };
};
exports.resolveNiftipayCredentialsForBrand = resolveNiftipayCredentialsForBrand;
const resolveNiftipayCredentialsForIntegration = (options, integrationId) => {
    if (integrationId === options.integrationId) {
        return {
            apiKey: options.apiKey,
            integrationId: options.integrationId,
            webhookSecret: options.webhookSecret,
        };
    }
    for (const [brandSlug, settings] of Object.entries(options.brandSettings ?? {})) {
        if (settings.integrationId === integrationId &&
            settings.webhookSecret) {
            return {
                apiKey: settings.apiKey ?? options.apiKey,
                integrationId,
                webhookSecret: settings.webhookSecret,
                brandSlug,
            };
        }
    }
    return undefined;
};
exports.resolveNiftipayCredentialsForIntegration = resolveNiftipayCredentialsForIntegration;
const validateNiftipayOptions = (options) => {
    for (const key of ["apiKey", "integrationId", "webhookSecret"]) {
        if (!(0, utils_2.optionalString)(options[key])) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay ${key} is required when the provider is enabled`);
        }
    }
    const secret = (0, utils_2.optionalString)(options.webhookSecret) ?? "";
    if (secret.length < 32) {
        throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Niftipay webhookSecret must contain at least 32 characters");
    }
    const brandSettings = (0, utils_2.isRecord)(options.brandSettings)
        ? options.brandSettings
        : {};
    const integrationOwners = new Map([
        [(0, utils_2.optionalString)(options.integrationId) ?? "", "default"],
    ]);
    for (const [brandSlug, candidate] of Object.entries(brandSettings)) {
        if (!(0, utils_2.isRecord)(candidate)) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay brandSettings.${brandSlug} must be an object`);
        }
        const apiKey = (0, utils_2.optionalString)(candidate.apiKey);
        const integrationId = (0, utils_2.optionalString)(candidate.integrationId);
        const webhookSecret = (0, utils_2.optionalString)(candidate.webhookSecret);
        if (Object.prototype.hasOwnProperty.call(candidate, "apiKey") &&
            !(0, utils_2.optionalString)(candidate.apiKey)) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay brandSettings.${brandSlug}.apiKey must be a non-empty string`);
        }
        if (apiKey && (!integrationId || !webhookSecret)) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay brandSettings.${brandSlug} must configure apiKey with integrationId and webhookSecret`);
        }
        if (Boolean(integrationId) !== Boolean(webhookSecret)) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay brandSettings.${brandSlug} must configure integrationId and webhookSecret together`);
        }
        if (webhookSecret && webhookSecret.length < 32) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay brandSettings.${brandSlug}.webhookSecret must contain at least 32 characters`);
        }
        if (integrationId) {
            const existingOwner = integrationOwners.get(integrationId);
            if (existingOwner && existingOwner !== brandSlug) {
                throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay integrationId must be unique per store; brandSettings.${brandSlug} duplicates ${existingOwner}`);
            }
            integrationOwners.set(integrationId, brandSlug);
        }
    }
};
exports.validateNiftipayOptions = validateNiftipayOptions;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3B0aW9ucy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvbmlmdGlwYXkvb3B0aW9ucy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxxREFBd0Q7QUFHeEQsMkRBQTJFO0FBcUQzRSxNQUFNLFFBQVEsR0FBRztJQUNmLE9BQU8sRUFBRSwwQkFBMEI7SUFDbkMsbUJBQW1CLEVBQUUsdUJBQXVCO0lBQzVDLGVBQWUsRUFBRSxVQUFVO0lBQzNCLHVCQUF1QixFQUFFLEdBQUc7SUFDNUIsc0JBQXNCLEVBQUUsS0FBSztJQUM3QixhQUFhLEVBQUUsRUFBRSxHQUFHLE1BQU07Q0FTM0IsQ0FBQztBQUVLLE1BQU0sWUFBWSxHQUFHLENBQzFCLE9BQWdDLEVBQ1AsRUFBRSxDQUFDLENBQUM7SUFDN0IsR0FBRyxRQUFRO0lBQ1gsR0FBRyxPQUFPO0lBQ1YsT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPLElBQUksUUFBUSxDQUFDLE9BQU87SUFDNUMsbUJBQW1CLEVBQ2pCLE9BQU8sQ0FBQyxtQkFBbUIsSUFBSSxRQUFRLENBQUMsbUJBQW1CO0lBQzdELGVBQWUsRUFBRSxPQUFPLENBQUMsZUFBZSxJQUFJLFFBQVEsQ0FBQyxlQUFlO0lBQ3BFLHVCQUF1QixFQUNyQixPQUFPLENBQUMsdUJBQXVCLElBQUksUUFBUSxDQUFDLHVCQUF1QjtJQUNyRSxzQkFBc0IsRUFDcEIsT0FBTyxDQUFDLHNCQUFzQixJQUFJLFFBQVEsQ0FBQyxzQkFBc0I7SUFDbkUsYUFBYSxFQUFFLE9BQU8sQ0FBQyxhQUFhLElBQUksUUFBUSxDQUFDLGFBQWE7Q0FDL0QsQ0FBQyxDQUFDO0FBZFUsUUFBQSxZQUFZLGdCQWN0QjtBQUVJLE1BQU0sa0NBQWtDLEdBQUcsQ0FDaEQsT0FBa0MsRUFDbEMsU0FBa0IsRUFDVyxFQUFFO0lBQy9CLE1BQU0sS0FBSyxHQUFHLFNBQVMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLGFBQWEsRUFBRSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7SUFDekUsT0FBTztRQUNMLE1BQU0sRUFBRSxLQUFLLEVBQUUsTUFBTSxJQUFJLE9BQU8sQ0FBQyxNQUFNO1FBQ3ZDLGFBQWEsRUFBRSxLQUFLLEVBQUUsYUFBYSxJQUFJLE9BQU8sQ0FBQyxhQUFhO1FBQzVELGFBQWEsRUFBRSxLQUFLLEVBQUUsYUFBYSxJQUFJLE9BQU8sQ0FBQyxhQUFhO1FBQzVELEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsU0FBUyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztLQUNwQyxDQUFDO0FBQ0osQ0FBQyxDQUFDO0FBWFcsUUFBQSxrQ0FBa0Msc0NBVzdDO0FBRUssTUFBTSx3Q0FBd0MsR0FBRyxDQUN0RCxPQUFrQyxFQUNsQyxhQUFxQixFQUNvQixFQUFFO0lBQzNDLElBQUksYUFBYSxLQUFLLE9BQU8sQ0FBQyxhQUFhLEVBQUUsQ0FBQztRQUM1QyxPQUFPO1lBQ0wsTUFBTSxFQUFFLE9BQU8sQ0FBQyxNQUFNO1lBQ3RCLGFBQWEsRUFBRSxPQUFPLENBQUMsYUFBYTtZQUNwQyxhQUFhLEVBQUUsT0FBTyxDQUFDLGFBQWE7U0FDckMsQ0FBQztJQUNKLENBQUM7SUFFRCxLQUFLLE1BQU0sQ0FBQyxTQUFTLEVBQUUsUUFBUSxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FDaEQsT0FBTyxDQUFDLGFBQWEsSUFBSSxFQUFFLENBQzVCLEVBQUUsQ0FBQztRQUNGLElBQ0UsUUFBUSxDQUFDLGFBQWEsS0FBSyxhQUFhO1lBQ3hDLFFBQVEsQ0FBQyxhQUFhLEVBQ3RCLENBQUM7WUFDRCxPQUFPO2dCQUNMLE1BQU0sRUFBRSxRQUFRLENBQUMsTUFBTSxJQUFJLE9BQU8sQ0FBQyxNQUFNO2dCQUN6QyxhQUFhO2dCQUNiLGFBQWEsRUFBRSxRQUFRLENBQUMsYUFBYTtnQkFDckMsU0FBUzthQUNWLENBQUM7UUFDSixDQUFDO0lBQ0gsQ0FBQztJQUVELE9BQU8sU0FBUyxDQUFDO0FBQ25CLENBQUMsQ0FBQztBQTdCVyxRQUFBLHdDQUF3Qyw0Q0E2Qm5EO0FBRUssTUFBTSx1QkFBdUIsR0FBRyxDQUNyQyxPQUFnQyxFQUMxQixFQUFFO0lBQ1IsS0FBSyxNQUFNLEdBQUcsSUFBSSxDQUFDLFFBQVEsRUFBRSxlQUFlLEVBQUUsZUFBZSxDQUFVLEVBQUUsQ0FBQztRQUN4RSxJQUFJLENBQUMsSUFBQSxzQkFBYyxFQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDbEMsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsWUFBWSxHQUFHLDJDQUEyQyxDQUMzRCxDQUFDO1FBQ0osQ0FBQztJQUNILENBQUM7SUFFRCxNQUFNLE1BQU0sR0FBRyxJQUFBLHNCQUFjLEVBQUMsT0FBTyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUMzRCxJQUFJLE1BQU0sQ0FBQyxNQUFNLEdBQUcsRUFBRSxFQUFFLENBQUM7UUFDdkIsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsNERBQTRELENBQzdELENBQUM7SUFDSixDQUFDO0lBRUQsTUFBTSxhQUFhLEdBQUcsSUFBQSxnQkFBUSxFQUFDLE9BQU8sQ0FBQyxhQUFhLENBQUM7UUFDbkQsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxhQUFhO1FBQ3ZCLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDUCxNQUFNLGlCQUFpQixHQUFHLElBQUksR0FBRyxDQUFpQjtRQUNoRCxDQUFDLElBQUEsc0JBQWMsRUFBQyxPQUFPLENBQUMsYUFBYSxDQUFDLElBQUksRUFBRSxFQUFFLFNBQVMsQ0FBQztLQUN6RCxDQUFDLENBQUM7SUFDSCxLQUFLLE1BQU0sQ0FBQyxTQUFTLEVBQUUsU0FBUyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxhQUFhLENBQUMsRUFBRSxDQUFDO1FBQ25FLElBQUksQ0FBQyxJQUFBLGdCQUFRLEVBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztZQUN6QixNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUM5QiwwQkFBMEIsU0FBUyxvQkFBb0IsQ0FDeEQsQ0FBQztRQUNKLENBQUM7UUFFRCxNQUFNLE1BQU0sR0FBRyxJQUFBLHNCQUFjLEVBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ2hELE1BQU0sYUFBYSxHQUFHLElBQUEsc0JBQWMsRUFBQyxTQUFTLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDOUQsTUFBTSxhQUFhLEdBQUcsSUFBQSxzQkFBYyxFQUFDLFNBQVMsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUM5RCxJQUNFLE1BQU0sQ0FBQyxTQUFTLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsUUFBUSxDQUFDO1lBQ3pELENBQUMsSUFBQSxzQkFBYyxFQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsRUFDakMsQ0FBQztZQUNELE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLDBCQUEwQixTQUFTLG9DQUFvQyxDQUN4RSxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksTUFBTSxJQUFJLENBQUMsQ0FBQyxhQUFhLElBQUksQ0FBQyxhQUFhLENBQUMsRUFBRSxDQUFDO1lBQ2pELE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLDBCQUEwQixTQUFTLDZEQUE2RCxDQUNqRyxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksT0FBTyxDQUFDLGFBQWEsQ0FBQyxLQUFLLE9BQU8sQ0FBQyxhQUFhLENBQUMsRUFBRSxDQUFDO1lBQ3RELE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLDBCQUEwQixTQUFTLDBEQUEwRCxDQUM5RixDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksYUFBYSxJQUFJLGFBQWEsQ0FBQyxNQUFNLEdBQUcsRUFBRSxFQUFFLENBQUM7WUFDL0MsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsMEJBQTBCLFNBQVMsb0RBQW9ELENBQ3hGLENBQUM7UUFDSixDQUFDO1FBQ0QsSUFBSSxhQUFhLEVBQUUsQ0FBQztZQUNsQixNQUFNLGFBQWEsR0FBRyxpQkFBaUIsQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLENBQUM7WUFDM0QsSUFBSSxhQUFhLElBQUksYUFBYSxLQUFLLFNBQVMsRUFBRSxDQUFDO2dCQUNqRCxNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUM5QixrRUFBa0UsU0FBUyxlQUFlLGFBQWEsRUFBRSxDQUMxRyxDQUFDO1lBQ0osQ0FBQztZQUNELGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxhQUFhLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFDbEQsQ0FBQztJQUNILENBQUM7QUFDSCxDQUFDLENBQUM7QUEzRVcsUUFBQSx1QkFBdUIsMkJBMkVsQyJ9