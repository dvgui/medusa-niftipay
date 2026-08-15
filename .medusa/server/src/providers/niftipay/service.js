"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("@medusajs/framework/utils");
const client_1 = require("../../lib/niftipay-client/client");
const money_1 = require("../../lib/niftipay-client/money");
const normalize_1 = require("../../lib/niftipay-client/normalize");
const utils_2 = require("../../lib/niftipay-client/utils");
const webhook_1 = require("../../lib/niftipay-client/webhook");
const options_1 = require("./options");
const session_store_1 = require("./session-store");
const paymentData = (value) => (0, utils_2.isRecord)(value) ? value : {};
const numberValue = (value) => (0, utils_2.optionalNumber)(value);
const normalizedCustomerName = (value) => (0, utils_2.optionalString)(value)?.replace(/\s+/g, " ").slice(0, 120);
const renderTemplate = (template, values) => template
    .replaceAll("{cart_id}", values.cartId)
    .replaceAll("{session_id}", values.sessionId)
    .replaceAll("{brand_slug}", values.brandSlug ?? "")
    .replaceAll("{customer_name}", values.customerName ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
const substituteUrl = (template, values) => {
    if (!template)
        return undefined;
    const replaced = template
        .replaceAll("{cart_id}", values.cartId)
        .replaceAll("{session_id}", values.sessionId);
    const parsed = new URL(replaced);
    if (parsed.protocol !== "https:") {
        throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Niftipay return and failure URLs must use HTTPS");
    }
    return parsed.toString();
};
const normalizedCurrency = (value) => value.toUpperCase();
class NiftipayPaymentProviderService extends utils_1.AbstractPaymentProvider {
    static validateOptions(options) {
        (0, options_1.validateNiftipayOptions)(options);
    }
    constructor(container, options) {
        super(container, options);
        this.verifiedSessions_ = new Map();
        this.logger_ = container.logger;
        this.options_ = (0, options_1.withDefaults)(options);
        this.client_ = new client_1.NiftipayClient({
            apiKey: options.apiKey,
            baseUrl: this.options_.baseUrl,
            allowedRedirectHosts: options.allowedRedirectHosts,
        });
        this.store_ = new session_store_1.NiftipaySessionStore(container, container.logger);
    }
    isRecentlyVerified(sessionId) {
        const verifiedAt = this.verifiedSessions_.get(sessionId);
        if (!verifiedAt)
            return false;
        if (Date.now() - verifiedAt > this.options_.verifiedTtlMs) {
            this.verifiedSessions_.delete(sessionId);
            return false;
        }
        return true;
    }
    async initiatePayment(input) {
        const data = paymentData(input.data);
        const sessionId = (0, utils_2.optionalString)(data.session_id) ?? "";
        const cartId = (0, utils_2.optionalString)(data.cart_id) ?? "";
        const amount = numberValue(input.amount);
        const currency = normalizedCurrency(input.currency_code || "gbp");
        const email = (0, utils_2.optionalString)(input.context?.customer?.email) ??
            (0, utils_2.optionalString)(data.email);
        const customerContext = paymentData(input.context?.customer);
        const contextCustomerName = normalizedCustomerName([
            (0, utils_2.optionalString)(customerContext.first_name),
            (0, utils_2.optionalString)(customerContext.last_name),
        ]
            .filter((part) => Boolean(part))
            .join(" "));
        const customerName = normalizedCustomerName(data.customer_name) ??
            normalizedCustomerName(customerContext.name) ??
            contextCustomerName;
        if (!/^payses_[A-Za-z0-9]+$/.test(sessionId)) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Niftipay payment session ID is missing or invalid");
        }
        if (!/^cart_[A-Za-z0-9]+$/.test(cartId)) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Niftipay requires a valid cart ID for the hosted return flow");
        }
        if (amount === undefined || amount <= 0) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Niftipay payment amount must be greater than zero");
        }
        if (!email) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Niftipay requires a customer email address");
        }
        const allowedCurrencies = (this.options_.allowedCurrencies ?? []).map(normalizedCurrency);
        if (allowedCurrencies.length > 0 && !allowedCurrencies.includes(currency)) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay does not allow ${currency} payments`);
        }
        // Validate the ISO minor-unit precision before creating the remote order.
        (0, money_1.toMinorUnits)(amount, currency);
        const serviceFeePayer = this.options_.serviceFeePayer;
        const brandSlug = (0, utils_2.optionalString)(data.niftipay_brand_slug) ??
            (0, utils_2.optionalString)(data.brand_slug);
        const brandSettings = brandSlug
            ? this.options_.brandSettings?.[brandSlug]
            : undefined;
        const credentials = (0, options_1.resolveNiftipayCredentialsForBrand)(this.options_, brandSlug);
        const integrationId = credentials.integrationId;
        const returnUrl = substituteUrl(brandSettings?.returnUrl ?? this.options_.returnUrl, { cartId, sessionId });
        const failureUrl = substituteUrl(brandSettings?.failureUrl ?? this.options_.failureUrl, { cartId, sessionId });
        if (!returnUrl) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay has no return URL configured for brand ${brandSlug ?? "default"}`);
        }
        const description = renderTemplate(brandSettings?.descriptionTemplate ?? this.options_.descriptionTemplate, { cartId, sessionId, brandSlug, customerName });
        const payload = {
            integrationId,
            currency,
            amount,
            email,
            description,
            reference: sessionId,
            merchantReference: sessionId,
            serviceFeePayer,
            ...(returnUrl ? { returnUrl } : {}),
            ...(failureUrl ? { failureUrl } : {}),
        };
        try {
            const created = await this.client_.createFiatOrder(payload);
            if (created.reference && created.reference !== sessionId) {
                throw new Error("Niftipay returned a different merchant reference");
            }
            const sessionData = {
                session_id: sessionId,
                cart_id: cartId,
                ...(brandSlug ? { brand_slug: brandSlug } : {}),
                niftipay_order_id: created.orderId,
                niftipay_order_key: created.orderKey,
                niftipay_redirect_url: created.payUrl,
                niftipay_reference: sessionId,
                niftipay_description: description,
                niftipay_integration_id: integrationId,
                niftipay_status: created.status ?? "created",
                niftipay_amount: amount,
                niftipay_currency: currency,
                niftipay_email: email,
                ...(customerName
                    ? { niftipay_customer_name: customerName }
                    : {}),
                ...(returnUrl ? { niftipay_return_url: returnUrl } : {}),
                ...(failureUrl ? { niftipay_failure_url: failureUrl } : {}),
                niftipay_service_fee_payer: serviceFeePayer,
            };
            return {
                id: created.orderKey,
                data: { ...data, ...sessionData },
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, `Failed to create Niftipay card payment: ${message}`);
        }
    }
    async authorizePayment(input) {
        const data = paymentData(input.data);
        const sessionId = (0, utils_2.optionalString)(data.session_id) ?? "";
        const status = (0, utils_2.optionalString)(data.niftipay_status)?.toLowerCase();
        const paid = status === "paid" ||
            (sessionId !== "" && this.isRecentlyVerified(sessionId));
        return {
            data,
            status: (paid ? "captured" : "pending"),
        };
    }
    async capturePayment(input) {
        return { data: paymentData(input.data) };
    }
    async cancelPayment(input) {
        // A local cart cancellation must not race a late successful card webhook.
        return { data: paymentData(input.data) };
    }
    async deletePayment(input) {
        // Switching methods only removes Medusa state; it does not refund/cancel.
        return { data: paymentData(input.data) };
    }
    async refundPayment(input) {
        const data = paymentData(input.data);
        const identifier = (0, utils_2.optionalString)(data.niftipay_order_key);
        const amount = numberValue(input.amount);
        const currency = (0, utils_2.optionalString)(data.niftipay_currency);
        if (!identifier || amount === undefined || !currency) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Niftipay order key, refund amount, and currency are required");
        }
        const amountCents = (0, money_1.toMinorUnits)(amount, currency);
        await this.client_.createFiatRefund(identifier, {
            amountCents,
            description: `Medusa refund for ${(0, utils_2.optionalString)(data.session_id) ?? identifier}`,
        });
        return {
            data: {
                ...data,
                niftipay_status: "refund_requested",
                niftipay_last_refund_amount: amount,
            },
        };
    }
    async retrievePayment(input) {
        const data = paymentData(input.data);
        const identifier = (0, utils_2.optionalString)(data.niftipay_order_key);
        if (!identifier)
            return { data };
        const remote = await this.client_.retrieveNormalizedFiatOrder(identifier);
        return {
            data: {
                ...data,
                ...(remote.status ? { niftipay_remote_status: remote.status } : {}),
            },
        };
    }
    async updatePayment(input) {
        const data = paymentData(input.data);
        const previousAmount = numberValue(data.niftipay_amount);
        const nextAmount = numberValue(input.amount);
        const previousCurrency = (0, utils_2.optionalString)(data.niftipay_currency);
        const nextCurrency = normalizedCurrency(input.currency_code || "");
        const amountChanged = previousAmount !== undefined &&
            nextAmount !== undefined &&
            Math.abs(previousAmount - nextAmount) >= 0.0000001;
        const currencyChanged = previousCurrency !== undefined &&
            nextCurrency !== "" &&
            previousCurrency !== nextCurrency;
        return {
            data: {
                ...data,
                ...(amountChanged || currencyChanged
                    ? { niftipay_payment_stale: true }
                    : {}),
            },
        };
    }
    async getPaymentStatus(input) {
        const data = paymentData(input.data);
        const status = (0, utils_2.optionalString)(data.niftipay_status)?.toLowerCase();
        const mapped = status === "paid"
            ? "captured"
            : [
                "cancelled",
                "canceled",
                "expired",
                "refunded",
                "chargeback",
            ].includes(status ?? "")
                ? "canceled"
                : "pending";
        return { status: mapped, data };
    }
    async resolveSession(orderKey, merchantReference) {
        if (merchantReference?.startsWith("payses_")) {
            const session = await this.store_.load(merchantReference);
            if (session)
                return session;
        }
        return orderKey ? this.store_.findByOrderKey(orderKey) : null;
    }
    credentialsForSession(session) {
        const storedIntegrationId = (0, utils_2.optionalString)(session.data?.niftipay_integration_id);
        if (storedIntegrationId) {
            const storedCredentials = (0, options_1.resolveNiftipayCredentialsForIntegration)(this.options_, storedIntegrationId);
            if (storedCredentials)
                return storedCredentials;
        }
        const brandSlug = (0, utils_2.optionalString)(session.data?.brand_slug);
        return (0, options_1.resolveNiftipayCredentialsForBrand)(this.options_, brandSlug);
    }
    async getWebhookActionAndData(payload) {
        const unsupported = {
            action: utils_1.PaymentActions.NOT_SUPPORTED,
            data: { session_id: "", amount: new utils_1.BigNumber(0) },
        };
        try {
            const rawBody = Buffer.isBuffer(payload.rawData)
                ? payload.rawData.toString("utf8")
                : String(payload.rawData ?? "");
            const webhook = (0, normalize_1.normalizeNiftipayWebhook)(payload.data);
            if (webhook.kind === "unsupported")
                return unsupported;
            const session = await this.resolveSession(webhook.kind === "payment" ? webhook.order.orderKey : undefined, webhook.kind === "payment"
                ? (webhook.order.merchantReference ?? webhook.order.reference)
                : webhook.merchantReference);
            if (!session || session.deleted_at || session.status === "canceled") {
                const event = webhook.kind === "payment" ? webhook.event : "risk_alert";
                const orderId = webhook.kind === "payment" ? webhook.order.id : undefined;
                this.logger_.warn(`[niftipay] ${event} webhook has no live payment session (orderId=${orderId ?? "unknown"})`);
                return unsupported;
            }
            const webhookIntegrationId = webhook.kind === "payment"
                ? webhook.order.integrationId
                : webhook.integrationId;
            const sessionCredentials = this.credentialsForSession(session);
            const webhookCredentials = webhookIntegrationId
                ? (0, options_1.resolveNiftipayCredentialsForIntegration)(this.options_, webhookIntegrationId)
                : undefined;
            if (webhookIntegrationId && !webhookCredentials) {
                this.logger_.warn("[niftipay] rejected webhook for an unknown integration");
                return unsupported;
            }
            const authenticated = (0, webhook_1.verifyNiftipayWebhook)({
                rawBody,
                headers: payload.headers ?? {},
                data: payload.data,
                options: {
                    secret: webhookCredentials?.webhookSecret ??
                        sessionCredentials.webhookSecret,
                    toleranceSeconds: this.options_.webhookToleranceSeconds,
                    allowLegacy: this.options_.allowLegacyWebhookAuth,
                },
            });
            if (!authenticated) {
                this.logger_.warn("[niftipay] rejected webhook authentication");
                return unsupported;
            }
            if (webhookIntegrationId &&
                webhookIntegrationId !== sessionCredentials.integrationId) {
                this.logger_.error(`[niftipay] integration mismatch for session ${session.id}`);
                return unsupported;
            }
            if (webhook.kind !== "payment") {
                if (webhook.kind === "risk_alert") {
                    this.logger_.warn(`[niftipay] risk alert received for reference=${webhook.merchantReference ?? "unknown"}`);
                }
                return unsupported;
            }
            const sessionData = session.data ?? {};
            if (!String(session.provider_id ?? "").includes("niftipay")) {
                this.logger_.error(`[niftipay] provider mismatch for session ${session.id}`);
                return unsupported;
            }
            const storedOrderKey = (0, utils_2.optionalString)(sessionData.niftipay_order_key);
            if (webhook.order.orderKey && storedOrderKey !== webhook.order.orderKey) {
                this.logger_.error(`[niftipay] orderKey mismatch for session ${session.id}`);
                return unsupported;
            }
            const webhookReference = webhook.order.merchantReference ?? webhook.order.reference;
            if ((webhookReference && webhookReference !== session.id) ||
                (webhook.event === "paid" && webhookReference !== session.id)) {
                this.logger_.error(`[niftipay] merchant reference mismatch for session ${session.id}`);
                return unsupported;
            }
            const storedOrderId = (0, utils_2.optionalString)(sessionData.niftipay_order_id);
            if ((storedOrderId && webhook.order.id !== storedOrderId) ||
                (webhook.event === "paid" && !webhook.order.id)) {
                this.logger_.error(`[niftipay] public order ID mismatch for session ${session.id}`);
                return unsupported;
            }
            const storedCurrency = (0, utils_2.optionalString)(sessionData.niftipay_currency)?.toUpperCase();
            if (webhook.order.currency &&
                storedCurrency &&
                webhook.order.currency !== storedCurrency) {
                this.logger_.error(`[niftipay] currency mismatch for session ${session.id}`);
                return unsupported;
            }
            if (webhook.event === "paid" && !webhook.order.currency) {
                this.logger_.error(`[niftipay] paid webhook has no currency for session ${session.id}`);
                return unsupported;
            }
            const sessionAmount = numberValue(session.amount);
            const expectedMinor = sessionAmount !== undefined && storedCurrency
                ? (0, money_1.toMinorUnits)(sessionAmount, storedCurrency)
                : undefined;
            const receivedMinor = [
                webhook.order.amountCents,
                webhook.order.subtotalCents,
            ].filter((value) => value !== undefined);
            if (expectedMinor !== undefined &&
                receivedMinor.length > 0 &&
                !receivedMinor.some((value) => Math.round(value) === expectedMinor)) {
                this.logger_.error(`[niftipay] amount mismatch for session ${session.id}`);
                return unsupported;
            }
            if (webhook.event === "paid" &&
                (expectedMinor === undefined || receivedMinor.length === 0)) {
                this.logger_.error(`[niftipay] paid webhook has no verifiable amount for session ${session.id}`);
                return unsupported;
            }
            await this.store_.stamp(session, {
                niftipay_status: webhook.event,
                ...(!storedOrderId && webhook.order.id
                    ? { niftipay_order_id: webhook.order.id }
                    : {}),
                ...(webhook.event === "paid"
                    ? { niftipay_verified_at: new Date().toISOString() }
                    : {}),
            });
            if (webhook.event === "paid") {
                if (sessionAmount === undefined)
                    return unsupported;
                this.verifiedSessions_.set(session.id, Date.now());
                return {
                    action: utils_1.PaymentActions.SUCCESSFUL,
                    data: {
                        session_id: session.id,
                        amount: new utils_1.BigNumber(sessionAmount),
                    },
                };
            }
            if (webhook.event === "cancelled" || webhook.event === "expired") {
                return {
                    action: utils_1.PaymentActions.FAILED,
                    data: { session_id: session.id, amount: new utils_1.BigNumber(0) },
                };
            }
            if (webhook.event === "chargeback") {
                this.logger_.error(`[niftipay] chargeback received for session ${session.id}`);
            }
            return unsupported;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger_.error(`[niftipay] webhook processing failed: ${message}`);
            return unsupported;
        }
    }
}
NiftipayPaymentProviderService.identifier = "niftipay";
exports.default = NiftipayPaymentProviderService;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvbmlmdGlwYXkvc2VydmljZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLHFEQUttQztBQTBCbkMsNkRBQWtFO0FBQ2xFLDJEQUErRDtBQUMvRCxtRUFBK0U7QUFLL0UsMkRBSXlDO0FBQ3pDLCtEQUEwRTtBQUMxRSx1Q0FPbUI7QUFDbkIsbURBQWdGO0FBeUJoRixNQUFNLFdBQVcsR0FBRyxDQUFDLEtBQWMsRUFBMkIsRUFBRSxDQUM5RCxJQUFBLGdCQUFRLEVBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0FBRS9CLE1BQU0sV0FBVyxHQUFHLENBQUMsS0FBYyxFQUFzQixFQUFFLENBQ3pELElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsQ0FBQztBQUV4QixNQUFNLHNCQUFzQixHQUFHLENBQUMsS0FBYyxFQUFzQixFQUFFLENBQ3BFLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsRUFBRSxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFFNUQsTUFBTSxjQUFjLEdBQUcsQ0FDckIsUUFBZ0IsRUFDaEIsTUFLRSxFQUNNLEVBQUUsQ0FDVixRQUFRO0tBQ0wsVUFBVSxDQUFDLFdBQVcsRUFBRSxNQUFNLENBQUMsTUFBTSxDQUFDO0tBQ3RDLFVBQVUsQ0FBQyxjQUFjLEVBQUUsTUFBTSxDQUFDLFNBQVMsQ0FBQztLQUM1QyxVQUFVLENBQUMsY0FBYyxFQUFFLE1BQU0sQ0FBQyxTQUFTLElBQUksRUFBRSxDQUFDO0tBQ2xELFVBQVUsQ0FBQyxpQkFBaUIsRUFBRSxNQUFNLENBQUMsWUFBWSxJQUFJLEVBQUUsQ0FBQztLQUN4RCxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQztLQUNw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