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
    const brandSettings = (0, utils_2.isRecord)(options.brandSettings)
        ? options.brandSettings
        : {};
    for (const [brandSlug, candidate] of Object.entries(brandSettings)) {
        if (!(0, utils_2.isRecord)(candidate)) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay brandSettings.${brandSlug} must be an object`);
        }
        const integrationId = (0, utils_2.optionalString)(candidate.integrationId);
        const webhookSecret = (0, utils_2.optionalString)(candidate.webhookSecret);
        if (Boolean(integrationId) !== Boolean(webhookSecret)) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay brandSettings.${brandSlug} must configure integrationId and webhookSecret together`);
        }
        if (webhookSecret && webhookSecret.length < 32) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay brandSettings.${brandSlug}.webhookSecret must contain at least 32 characters`);
        }
    }
};
exports.validateNiftipayOptions = validateNiftipayOptions;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3B0aW9ucy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvbmlmdGlwYXkvb3B0aW9ucy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxxREFBd0Q7QUFHeEQsMkRBQTJFO0FBd0MzRSxNQUFNLFFBQVEsR0FBRztJQUNmLE9BQU8sRUFBRSwwQkFBMEI7SUFDbkMsbUJBQW1CLEVBQUUsdUJBQXVCO0lBQzVDLGVBQWUsRUFBRSxVQUFVO0lBQzNCLHVCQUF1QixFQUFFLEdBQUc7SUFDNUIsc0JBQXNCLEVBQUUsS0FBSztJQUM3QixhQUFhLEVBQUUsRUFBRSxHQUFHLE1BQU07Q0FTM0IsQ0FBQztBQUVLLE1BQU0sWUFBWSxHQUFHLENBQzFCLE9BQWdDLEVBQ1AsRUFBRSxDQUFDLENBQUM7SUFDN0IsR0FBRyxRQUFRO0lBQ1gsR0FBRyxPQUFPO0lBQ1YsT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPLElBQUksUUFBUSxDQUFDLE9BQU87SUFDNUMsbUJBQW1CLEVBQ2pCLE9BQU8sQ0FBQyxtQkFBbUIsSUFBSSxRQUFRLENBQUMsbUJBQW1CO0lBQzdELGVBQWUsRUFBRSxPQUFPLENBQUMsZUFBZSxJQUFJLFFBQVEsQ0FBQyxlQUFlO0lBQ3BFLHVCQUF1QixFQUNyQixPQUFPLENBQUMsdUJBQXVCLElBQUksUUFBUSxDQUFDLHVCQUF1QjtJQUNyRSxzQkFBc0IsRUFDcEIsT0FBTyxDQUFDLHNCQUFzQixJQUFJLFFBQVEsQ0FBQyxzQkFBc0I7SUFDbkUsYUFBYSxFQUFFLE9BQU8sQ0FBQyxhQUFhLElBQUksUUFBUSxDQUFDLGFBQWE7Q0FDL0QsQ0FBQyxDQUFDO0FBZFUsUUFBQSxZQUFZLGdCQWN0QjtBQUVJLE1BQU0sdUJBQXVCLEdBQUcsQ0FDckMsT0FBZ0MsRUFDMUIsRUFBRTtJQUNSLEtBQUssTUFBTSxHQUFHLElBQUksQ0FBQyxRQUFRLEVBQUUsZUFBZSxFQUFFLGVBQWUsQ0FBVSxFQUFFLENBQUM7UUFDeEUsSUFBSSxDQUFDLElBQUEsc0JBQWMsRUFBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxDQUFDO1lBQ2xDLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLFlBQVksR0FBRywyQ0FBMkMsQ0FDM0QsQ0FBQztRQUNKLENBQUM7SUFDSCxDQUFDO0lBRUQsTUFBTSxNQUFNLEdBQUcsSUFBQSxzQkFBYyxFQUFDLE9BQU8sQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDM0QsSUFBSSxNQUFNLENBQUMsTUFBTSxHQUFHLEVBQUUsRUFBRSxDQUFDO1FBQ3ZCLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLDREQUE0RCxDQUM3RCxDQUFDO0lBQ0osQ0FBQztJQUVELE1BQU0sYUFBYSxHQUFHLElBQUEsZ0JBQVEsRUFBQyxPQUFPLENBQUMsYUFBYSxDQUFDO1FBQ25ELENBQUMsQ0FBQyxPQUFPLENBQUMsYUFBYTtRQUN2QixDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ1AsS0FBSyxNQUFNLENBQUMsU0FBUyxFQUFFLFNBQVMsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsYUFBYSxDQUFDLEVBQUUsQ0FBQztRQUNuRSxJQUFJLENBQUMsSUFBQSxnQkFBUSxFQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7WUFDekIsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsMEJBQTBCLFNBQVMsb0JBQW9CLENBQ3hELENBQUM7UUFDSixDQUFDO1FBRUQsTUFBTSxhQUFhLEdBQUcsSUFBQSxzQkFBYyxFQUFDLFNBQVMsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUM5RCxNQUFNLGFBQWEsR0FBRyxJQUFBLHNCQUFjLEVBQUMsU0FBUyxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQzlELElBQUksT0FBTyxDQUFDLGFBQWEsQ0FBQyxLQUFLLE9BQU8sQ0FBQyxhQUFhLENBQUMsRUFBRSxDQUFDO1lBQ3RELE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLDBCQUEwQixTQUFTLDBEQUEwRCxDQUM5RixDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksYUFBYSxJQUFJLGFBQWEsQ0FBQyxNQUFNLEdBQUcsRUFBRSxFQUFFLENBQUM7WUFDL0MsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsMEJBQTBCLFNBQVMsb0RBQW9ELENBQ3hGLENBQUM7UUFDSixDQUFDO0lBQ0gsQ0FBQztBQUNILENBQUMsQ0FBQztBQTlDVyxRQUFBLHVCQUF1QiwyQkE4Q2xDIn0=