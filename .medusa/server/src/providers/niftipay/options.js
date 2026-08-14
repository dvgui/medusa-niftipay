"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateNiftipayOptions = exports.withDefaults = void 0;
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
};
exports.validateNiftipayOptions = validateNiftipayOptions;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3B0aW9ucy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvbmlmdGlwYXkvb3B0aW9ucy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxxREFBdUQ7QUFHdkQsMkRBQWdFO0FBc0NoRSxNQUFNLFFBQVEsR0FBRztJQUNmLE9BQU8sRUFBRSwwQkFBMEI7SUFDbkMsbUJBQW1CLEVBQUUsdUJBQXVCO0lBQzVDLGVBQWUsRUFBRSxVQUFVO0lBQzNCLHVCQUF1QixFQUFFLEdBQUc7SUFDNUIsc0JBQXNCLEVBQUUsS0FBSztJQUM3QixhQUFhLEVBQUUsRUFBRSxHQUFHLE1BQU07Q0FTM0IsQ0FBQTtBQUVNLE1BQU0sWUFBWSxHQUFHLENBQzFCLE9BQWdDLEVBQ1AsRUFBRSxDQUFDLENBQUM7SUFDN0IsR0FBRyxRQUFRO0lBQ1gsR0FBRyxPQUFPO0lBQ1YsT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPLElBQUksUUFBUSxDQUFDLE9BQU87SUFDNUMsbUJBQW1CLEVBQ2pCLE9BQU8sQ0FBQyxtQkFBbUIsSUFBSSxRQUFRLENBQUMsbUJBQW1CO0lBQzdELGVBQWUsRUFBRSxPQUFPLENBQUMsZUFBZSxJQUFJLFFBQVEsQ0FBQyxlQUFlO0lBQ3BFLHVCQUF1QixFQUNyQixPQUFPLENBQUMsdUJBQXVCLElBQUksUUFBUSxDQUFDLHVCQUF1QjtJQUNyRSxzQkFBc0IsRUFDcEIsT0FBTyxDQUFDLHNCQUFzQixJQUFJLFFBQVEsQ0FBQyxzQkFBc0I7SUFDbkUsYUFBYSxFQUFFLE9BQU8sQ0FBQyxhQUFhLElBQUksUUFBUSxDQUFDLGFBQWE7Q0FDL0QsQ0FBQyxDQUFBO0FBZFcsUUFBQSxZQUFZLGdCQWN2QjtBQUVLLE1BQU0sdUJBQXVCLEdBQUcsQ0FDckMsT0FBZ0MsRUFDMUIsRUFBRTtJQUNSLEtBQUssTUFBTSxHQUFHLElBQUksQ0FBQyxRQUFRLEVBQUUsZUFBZSxFQUFFLGVBQWUsQ0FBVSxFQUFFLENBQUM7UUFDeEUsSUFBSSxDQUFDLElBQUEsc0JBQWMsRUFBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxDQUFDO1lBQ2xDLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLFlBQVksR0FBRywyQ0FBMkMsQ0FDM0QsQ0FBQTtRQUNILENBQUM7SUFDSCxDQUFDO0lBRUQsTUFBTSxNQUFNLEdBQUcsSUFBQSxzQkFBYyxFQUFDLE9BQU8sQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLENBQUE7SUFDMUQsSUFBSSxNQUFNLENBQUMsTUFBTSxHQUFHLEVBQUUsRUFBRSxDQUFDO1FBQ3ZCLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLDREQUE0RCxDQUM3RCxDQUFBO0lBQ0gsQ0FBQztBQUNILENBQUMsQ0FBQTtBQW5CWSxRQUFBLHVCQUF1QiwyQkFtQm5DIn0=