"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NiftipayClient = exports.parseCreatedNiftipayOrder = void 0;
const utils_1 = require("@medusajs/framework/utils");
const normalize_1 = require("./normalize");
const utils_2 = require("./utils");
const DEFAULT_BASE_URL = "https://www.niftipay.com";
const DEFAULT_TIMEOUT_MS = 25_000;
const normalizeHost = (host) => host.trim().toLowerCase();
const isAllowedRedirectHost = (hostname, allowedHosts) => {
    const candidate = normalizeHost(hostname);
    return allowedHosts.some((host) => {
        const allowed = normalizeHost(host);
        return candidate === allowed || candidate.endsWith(`.${allowed}`);
    });
};
const parseCreatedNiftipayOrder = (value, allowedRedirectHosts = []) => {
    if (!(0, utils_2.isRecord)(value)) {
        throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, "Niftipay returned an invalid create-order response");
    }
    const order = (0, utils_2.isRecord)(value.order) ? value.order : {};
    const payUrl = (0, utils_2.optionalString)(value.payUrl) ??
        (0, utils_2.optionalString)(order.orderUrl) ??
        (0, utils_2.optionalString)(order.payUrl);
    const orderKey = (0, utils_2.optionalString)(order.orderKey) ??
        (0, utils_2.optionalString)(order.order_key) ??
        (0, utils_2.optionalString)(value.orderKey);
    const orderId = (0, utils_2.optionalString)(order.id) ?? (0, utils_2.optionalString)(value.id);
    if (!payUrl || !orderKey || !orderId) {
        throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, "Niftipay create-order response is missing payUrl, orderKey, or order.id");
    }
    let redirect;
    try {
        redirect = new URL(payUrl);
    }
    catch {
        throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, "Niftipay returned an invalid payment URL");
    }
    if (redirect.protocol !== "https:") {
        throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, "Niftipay payment URL must use HTTPS");
    }
    if (allowedRedirectHosts.length > 0 &&
        !isAllowedRedirectHost(redirect.hostname, allowedRedirectHosts)) {
        throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, "Niftipay returned a payment URL on an unapproved host");
    }
    return {
        orderId,
        orderKey,
        payUrl: redirect.toString(),
        status: (0, utils_2.optionalString)(order.status) ?? (0, utils_2.optionalString)(value.status),
        reference: (0, utils_2.optionalString)(value.reference) ??
            (0, utils_2.optionalString)(order.merchantReference),
    };
};
exports.parseCreatedNiftipayOrder = parseCreatedNiftipayOrder;
class NiftipayClient {
    constructor(options) {
        this.apiKey = options.apiKey.trim();
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
        this.allowedRedirectHosts = options.allowedRedirectHosts ?? [];
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const base = new URL(this.baseUrl);
        if (base.protocol !== "https:") {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Niftipay base URL must use HTTPS");
        }
    }
    toJSON() {
        return { baseUrl: this.baseUrl };
    }
    async request(method, path, body) {
        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    "x-api-key": this.apiKey,
                    Accept: "application/json",
                    "Content-Type": "application/json",
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                redirect: "error",
                signal: AbortSignal.timeout(this.timeoutMs),
            });
            const raw = await response.text();
            let decoded = {};
            if (raw) {
                try {
                    decoded = JSON.parse(raw);
                }
                catch {
                    decoded = {};
                }
            }
            if (!response.ok) {
                const fallback = `Niftipay API error (HTTP ${response.status})`;
                throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, (0, utils_2.responseMessage)(decoded, fallback).slice(0, 500));
            }
            return decoded;
        }
        catch (error) {
            if (error instanceof utils_1.MedusaError)
                throw error;
            const message = error instanceof Error && error.name === "TimeoutError"
                ? "Niftipay API request timed out"
                : "Niftipay API request failed";
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, message);
        }
    }
    async createFiatOrder(payload) {
        return (0, exports.parseCreatedNiftipayOrder)(await this.request("POST", "/api/fiat/orders", payload), this.allowedRedirectHosts);
    }
    async retrieveFiatOrder(identifier) {
        return this.request("GET", `/api/fiat/orders/${encodeURIComponent(identifier)}`);
    }
    async retrieveNormalizedFiatOrder(identifier) {
        const response = await this.retrieveFiatOrder(identifier);
        const envelope = (0, utils_2.isRecord)(response) ? response : {};
        return (0, normalize_1.normalizeNiftipayOrder)((0, utils_2.isRecord)(envelope.order) ? envelope.order : envelope);
    }
    async cancelFiatOrder(identifier) {
        return this.request("DELETE", `/api/fiat/orders/${encodeURIComponent(identifier)}`);
    }
    async createFiatRefund(identifier, payload) {
        return this.request("POST", `/api/fiat/orders/${encodeURIComponent(identifier)}/refunds`, payload);
    }
}
exports.NiftipayClient = NiftipayClient;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xpZW50LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9uaWZ0aXBheS1jbGllbnQvY2xpZW50LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLHFEQUF1RDtBQUV2RCwyQ0FBb0Q7QUFRcEQsbUNBSWdCO0FBRWhCLE1BQU0sZ0JBQWdCLEdBQUcsMEJBQTBCLENBQUE7QUFDbkQsTUFBTSxrQkFBa0IsR0FBRyxNQUFNLENBQUE7QUFFakMsTUFBTSxhQUFhLEdBQUcsQ0FBQyxJQUFZLEVBQVUsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQTtBQUV6RSxNQUFNLHFCQUFxQixHQUFHLENBQzVCLFFBQWdCLEVBQ2hCLFlBQStCLEVBQ3RCLEVBQUU7SUFDWCxNQUFNLFNBQVMsR0FBRyxhQUFhLENBQUMsUUFBUSxDQUFDLENBQUE7SUFDekMsT0FBTyxZQUFZLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUU7UUFDaEMsTUFBTSxPQUFPLEdBQUcsYUFBYSxDQUFDLElBQUksQ0FBQyxDQUFBO1FBQ25DLE9BQU8sU0FBUyxLQUFLLE9BQU8sSUFBSSxTQUFTLENBQUMsUUFBUSxDQUFDLElBQUksT0FBTyxFQUFFLENBQUMsQ0FBQTtJQUNuRSxDQUFDLENBQUMsQ0FBQTtBQUNKLENBQUMsQ0FBQTtBQUVNLE1BQU0seUJBQXlCLEdBQUcsQ0FDdkMsS0FBYyxFQUNkLHVCQUEwQyxFQUFFLEVBQ3RCLEVBQUU7SUFDeEIsSUFBSSxDQUFDLElBQUEsZ0JBQVEsRUFBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ3JCLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxnQkFBZ0IsRUFDbEMsb0RBQW9ELENBQ3JELENBQUE7SUFDSCxDQUFDO0lBRUQsTUFBTSxLQUFLLEdBQUcsSUFBQSxnQkFBUSxFQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMs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