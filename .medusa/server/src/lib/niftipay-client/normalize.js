"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeNiftipayWebhook = exports.normalizeNiftipayOrder = void 0;
const types_1 = require("./types");
const utils_1 = require("./utils");
const isPaymentEvent = (value) => types_1.NIFTIPAY_PAYMENT_EVENTS.includes(value);
const normalizeNiftipayOrder = (value) => {
    if (!(0, utils_1.isRecord)(value))
        return {};
    return {
        id: (0, utils_1.optionalString)(value.id),
        integrationId: (0, utils_1.optionalString)(value.integrationId),
        orderKey: (0, utils_1.optionalString)(value.orderKey) ?? (0, utils_1.optionalString)(value.order_key),
        merchantReference: (0, utils_1.optionalString)(value.merchantReference),
        status: (0, utils_1.optionalString)(value.status)?.toLowerCase(),
        currency: (0, utils_1.optionalString)(value.currency)?.toUpperCase(),
        amountCents: (0, utils_1.optionalNumber)(value.amountCents),
        subtotalCents: (0, utils_1.optionalNumber)(value.subtotalCents),
        serviceFeePayer: (0, utils_1.optionalString)(value.serviceFeePayer),
        email: (0, utils_1.optionalString)(value.email),
        pspOrderId: (0, utils_1.optionalString)(value.pspOrderId),
        pspStatus: (0, utils_1.optionalString)(value.pspStatus)?.toLowerCase(),
        pspTransactionCount: (0, utils_1.optionalNumber)(value.pspTransactionCount),
        completedAt: (0, utils_1.optionalString)(value.completedAt),
        updatedAt: (0, utils_1.optionalString)(value.updatedAt),
    };
};
exports.normalizeNiftipayOrder = normalizeNiftipayOrder;
const normalizeNiftipayWebhook = (value) => {
    if (!(0, utils_1.isRecord)(value)) {
        return { kind: "unsupported", reason: "missing_event" };
    }
    const rawEvent = (0, utils_1.optionalString)(value.event) ?? (0, utils_1.optionalString)(value.type);
    const event = rawEvent?.toLowerCase();
    if (!event)
        return { kind: "unsupported", reason: "missing_event" };
    if (event === "risk_alert") {
        const alert = (0, utils_1.isRecord)(value.alert) ? value.alert : {};
        const order = (0, utils_1.isRecord)(value.order) ? value.order : {};
        return {
            kind: "risk_alert",
            integrationId: (0, utils_1.optionalString)(alert.integrationId) ??
                (0, utils_1.optionalString)(order.integrationId),
            merchantReference: (0, utils_1.optionalString)(alert.merchantReference) ??
                (0, utils_1.optionalString)(order.merchantReference),
        };
    }
    if (!isPaymentEvent(event)) {
        return { kind: "unsupported", event, reason: "unknown_event" };
    }
    if (!(0, utils_1.isRecord)(value.order)) {
        return { kind: "unsupported", event, reason: "missing_order" };
    }
    const order = (0, exports.normalizeNiftipayOrder)(value.order);
    const pricing = (0, utils_1.isRecord)(value.pricing) ? value.pricing : {};
    return {
        kind: "payment",
        event,
        order: {
            ...order,
            reference: (0, utils_1.optionalString)(value.order.reference),
            subtotalCents: order.subtotalCents ?? (0, utils_1.optionalNumber)(pricing.subtotalCents),
        },
    };
};
exports.normalizeNiftipayWebhook = normalizeNiftipayWebhook;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibm9ybWFsaXplLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9uaWZ0aXBheS1jbGllbnQvbm9ybWFsaXplLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUtnQjtBQUNoQixtQ0FJZ0I7QUFFaEIsTUFBTSxjQUFjLEdBQUcsQ0FBQyxLQUFhLEVBQWlDLEVBQUUsQ0FDckUsK0JBQTZDLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFBO0FBRXpELE1BQU0sc0JBQXNCLEdBQUcsQ0FDcEMsS0FBYyxFQUNPLEVBQUU7SUFDdkIsSUFBSSxDQUFDLElBQUEsZ0JBQVEsRUFBQyxLQUFLLENBQUM7UUFBRSxPQUFPLEVBQUUsQ0FBQTtJQUMvQixPQUFPO1FBQ0wsRUFBRSxFQUFFLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQzVCLGFBQWEsRUFBRSxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQztRQUNsRCxRQUFRLEVBQ04sSUFBQSxzQkFBYyxFQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsSUFBSSxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQztRQUNuRSxpQkFBaUIsRUFBRSxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLGlCQUFpQixDQUFDO1FBQzFELE1BQU0sRUFBRSxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxFQUFFLFdBQVcsRUFBRTtRQUNuRCxRQUFRLEVBQUUsSUFBQSxzQkFBYyxFQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsRUFBRSxXQUFXLEVBQUU7UUFDdkQsV0FBVyxFQUFFLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsV0FBVyxDQUFDO1FBQzlDLGFBQWEsRUFBRSxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQztRQUNsRCxlQUFlLEVBQUUsSUFBQSxzQkFBYyxFQUFDLEtBQUssQ0FB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