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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibm9ybWFsaXplLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9uaWZ0aXBheS1jbGllbnQvbm9ybWFsaXplLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUtnQjtBQUNoQixtQ0FJZ0I7QUFFaEIsTUFBTSxjQUFjLEdBQUcsQ0FBQyxLQUFhLEVBQWlDLEVBQUUsQ0FDckUsK0JBQTZDLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFBO0FBRXpELE1BQU0sc0JBQXNCLEdBQUcsQ0FDcEMsS0FBYyxFQUNPLEVBQUU7SUFDdkIsSUFBSSxDQUFDLElBQUEsZ0JBQVEsRUFBQyxLQUFLLENBQUM7UUFBRSxPQUFPLEVBQUUsQ0FBQTtJQUMvQixPQUFPO1FBQ0wsRUFBRSxFQUFFLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQzVCLGFBQWEsRUFBRSxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQztRQUNsRCxRQUFRLEVBQ04sSUFBQSxzQkFBYyxFQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsSUFBSSxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQztRQUNuRSxpQkFBaUIsRUFBRSxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLGlCQUFpQixDQUFDO1FBQzFELE1BQU0sRUFBRSxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxFQUFFLFdBQVcsRUFBRTtRQUNuRCxRQUFRLEVBQUUsSUFBQSxzQkFBYyxFQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsRUFBRSxXQUFXLEVBQUU7UUFDdkQsV0FBVyxFQUFFLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsV0FBVyxDQUFDO1FBQzlDLGFBQWEsRUFBRSxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQztRQUNsRCxlQUFlLEVBQUUsSUFBQSxzQkFBYyxFQUFDLEtBQUssQ0FBQyxlQUFlLENBQUM7S0FDdkQsQ0FBQTtBQUNILENBQUMsQ0FBQTtBQWhCWSxRQUFBLHNCQUFzQiwwQkFnQmxDO0FBRU0sTUFBTSx3QkFBd0IsR0FBRyxDQUN0QyxLQUFjLEVBQ2EsRUFBRTtJQUM3QixJQUFJLENBQUMsSUFBQSxnQkFBUSxFQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDckIsT0FBTyxFQUFFLElBQUksRUFBRSxhQUFhLEVBQUUsTUFBTSxFQUFFLGVBQWUsRUFBRSxDQUFBO0lBQ3pELENBQUM7SUFFRCxNQUFNLFFBQVEsR0FBRyxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxJQUFJLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUE7SUFDMUUsTUFBTSxLQUFLLEdBQUcsUUFBUSxFQUFFLFdBQVcsRUFBRSxDQUFBO0lBQ3JDLElBQUksQ0FBQyxLQUFLO1FBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxhQUFhLEVBQUUsTUFBTSxFQUFFLGVBQWUsRUFBRSxDQUFBO0lBRW5FLElBQUksS0FBSyxLQUFLLFlBQVksRUFBRSxDQUFDO1FBQzNCLE1BQU0sS0FBSyxHQUFHLElBQUEsZ0JBQVEsRUFBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQTtRQUN0RCxNQUFNLEtBQUssR0FBRyxJQUFBLGdCQUFRLEVBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUE7UUFDdEQsT0FBTztZQUNMLElBQUksRUFBRSxZQUFZO1lBQ2xCLGFBQWEsRUFDWCxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQztnQkFDbkMsSUFBQSxzQkFBYyxFQUFDLEtBQUssQ0FBQyxhQUFhLENBQUM7WUFDckMsaUJBQWlCLEVBQ2YsSUFBQSxzQkFBYyxFQUFDLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQztnQkFDdkMsSUFBQSxzQkFBYyxFQUFDLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQztTQUMxQyxDQUFBO0lBQ0gsQ0FBQztJQUVELElBQUksQ0FBQyxjQUFjLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUMzQixPQUFPLEVBQUUsSUFBSSxFQUFFLGFBQWEsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLGVBQWUsRUFBRSxDQUFBO0lBQ2hFLENBQUM7SUFDRCxJQUFJLENBQUMsSUFBQSxnQkFBUSxFQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQzNCLE9BQU8sRUFBRSxJQUFJLEVBQUUsYUFBYSxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsZUFBZSxFQUFFLENBQUE7SUFDaEUsQ0FBQztJQUVELE1BQU0sS0FBSyxHQUFHLElBQUEsOEJBQXNCLEVBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBO0lBQ2pELE1BQU0sT0FBTyxHQUFHLElBQUEsZ0JBQVEsRUFBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQTtJQUM1RCxPQUFPO1FBQ0wsSUFBSSxFQUFFLFNBQVM7UUFDZixLQUFLO1FBQ0wsS0FBSyxFQUFFO1lBQ0wsR0FBRyxLQUFLO1lBQ1IsU0FBUyxFQUFFLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQztZQUNoRCxhQUFhLEVBQ1gsS0FBSyxDQUFDLGFBQWEsSUFBSSxJQUFBLHNCQUFjLEVBQUMsT0FBTyxDQUFDLGFBQWEsQ0FBQztTQUMvRDtLQUNGLENBQUE7QUFDSCxDQUFDLENBQUE7QUE1Q1ksUUFBQSx3QkFBd0IsNEJBNENwQyJ9