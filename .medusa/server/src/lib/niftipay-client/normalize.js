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
        orderKey: (0, utils_1.optionalString)(value.orderKey) ?? (0, utils_1.optionalString)(value.order_key),
        merchantReference: (0, utils_1.optionalString)(value.merchantReference),
        status: (0, utils_1.optionalString)(value.status)?.toLowerCase(),
        currency: (0, utils_1.optionalString)(value.currency)?.toUpperCase(),
        amountCents: (0, utils_1.optionalNumber)(value.amountCents),
        subtotalCents: (0, utils_1.optionalNumber)(value.subtotalCents),
        serviceFeePayer: (0, utils_1.optionalString)(value.serviceFeePayer),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibm9ybWFsaXplLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9uaWZ0aXBheS1jbGllbnQvbm9ybWFsaXplLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUtnQjtBQUNoQixtQ0FJZ0I7QUFFaEIsTUFBTSxjQUFjLEdBQUcsQ0FBQyxLQUFhLEVBQWlDLEVBQUUsQ0FDckUsK0JBQTZDLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFBO0FBRXpELE1BQU0sc0JBQXNCLEdBQUcsQ0FDcEMsS0FBYyxFQUNPLEVBQUU7SUFDdkIsSUFBSSxDQUFDLElBQUEsZ0JBQVEsRUFBQyxLQUFLLENBQUM7UUFBRSxPQUFPLEVBQUUsQ0FBQTtJQUMvQixPQUFPO1FBQ0wsRUFBRSxFQUFFLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQzVCLFFBQVEsRUFDTixJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxJQUFJLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsU0FBUyxDQUFDO1FBQ25FLGlCQUFpQixFQUFFLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsaUJBQWlCLENBQUM7UUFDMUQsTUFBTSxFQUFFLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsV0FBVyxFQUFFO1FBQ25ELFFBQVEsRUFBRSxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxFQUFFLFdBQVcsRUFBRTtRQUN2RCxXQUFXLEVBQUUsSUFBQSxzQkFBYyxFQUFDLEtBQUssQ0FBQyxXQUFXLENBQUM7UUFDOUMsYUFBYSxFQUFFLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsYUFBYSxDQUFDO1FBQ2xELGVBQWUsRUFBRSxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLGVBQWUsQ0FBQztLQUN2RCxDQUFBO0FBQ0gsQ0FBQyxDQUFBO0FBZlksUUFBQSxzQkFB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