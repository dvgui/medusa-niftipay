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
const renderTemplate = (template, values) => template
    .replaceAll("{cart_id}", values.cartId)
    .replaceAll("{session_id}", values.sessionId)
    .replaceAll("{brand_slug}", values.brandSlug ?? "")
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
        if (allowedCurrencies.length > 0 &&
            !allowedCurrencies.includes(currency)) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay does not allow ${currency} payments`);
        }
        // Validate the ISO minor-unit precision before creating the remote order.
        (0, money_1.toMinorUnits)(amount, currency);
        const serviceFeePayer = this.options_.serviceFeePayer;
        const brandSlug = (0, utils_2.optionalString)(data.brand_slug);
        const brandSettings = brandSlug
            ? this.options_.brandSettings?.[brandSlug]
            : undefined;
        const returnUrl = substituteUrl(brandSettings?.returnUrl ?? this.options_.returnUrl, { cartId, sessionId });
        const failureUrl = substituteUrl(brandSettings?.failureUrl ?? this.options_.failureUrl, { cartId, sessionId });
        if (!returnUrl) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay has no return URL configured for brand ${brandSlug ?? "default"}`);
        }
        const description = renderTemplate(brandSettings?.descriptionTemplate ??
            this.options_.descriptionTemplate, { cartId, sessionId, brandSlug });
        const payload = {
            integrationId: this.options_.integrationId,
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
                niftipay_status: created.status ?? "created",
                niftipay_amount: amount,
                niftipay_currency: currency,
                niftipay_email: email,
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
                ...(remote.status
                    ? { niftipay_remote_status: remote.status }
                    : {}),
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
            : ["cancelled", "canceled", "expired", "refunded", "chargeback"].includes(status ?? "")
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
    async getWebhookActionAndData(payload) {
        const unsupported = {
            action: utils_1.PaymentActions.NOT_SUPPORTED,
            data: { session_id: "", amount: new utils_1.BigNumber(0) },
        };
        try {
            const rawBody = Buffer.isBuffer(payload.rawData)
                ? payload.rawData.toString("utf8")
                : String(payload.rawData ?? "");
            const authenticated = (0, webhook_1.verifyNiftipayWebhook)({
                rawBody,
                headers: payload.headers ?? {},
                data: payload.data,
                options: {
                    secret: this.options_.webhookSecret,
                    toleranceSeconds: this.options_.webhookToleranceSeconds,
                    allowLegacy: this.options_.allowLegacyWebhookAuth,
                },
            });
            if (!authenticated) {
                this.logger_.warn("[niftipay] rejected webhook authentication");
                return unsupported;
            }
            const webhook = (0, normalize_1.normalizeNiftipayWebhook)(payload.data);
            if (webhook.kind !== "payment") {
                if (webhook.kind === "risk_alert") {
                    this.logger_.warn(`[niftipay] risk alert received for reference=${webhook.merchantReference ?? "unknown"}`);
                }
                return unsupported;
            }
            const session = await this.resolveSession(webhook.order.orderKey, webhook.order.merchantReference ?? webhook.order.reference);
            if (!session || session.deleted_at || session.status === "canceled") {
                this.logger_.warn(`[niftipay] ${webhook.event} webhook has no live payment session (orderId=${webhook.order.id ?? "unknown"})`);
                return unsupported;
            }
            const sessionData = session.data ?? {};
            if (!String(session.provider_id ?? "").includes("niftipay")) {
                this.logger_.error(`[niftipay] provider mismatch for session ${session.id}`);
                return unsupported;
            }
            const storedOrderKey = (0, utils_2.optionalString)(sessionData.niftipay_order_key);
            if (webhook.order.orderKey &&
                storedOrderKey !== webhook.order.orderKey) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvbmlmdGlwYXkvc2VydmljZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLHFEQUtrQztBQTBCbEMsNkRBQWlFO0FBQ2pFLDJEQUE4RDtBQUM5RCxtRUFBOEU7QUFLOUUsMkRBSXdDO0FBQ3hDLCtEQUF5RTtBQUN6RSx1Q0FLa0I7QUFDbEIsbURBR3dCO0FBdUJ4QixNQUFNLFdBQVcsR0FBRyxDQUFDLEtBQWMsRUFBMkIsRUFBRSxDQUM5RCxJQUFBLGdCQUFRLEVBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFBO0FBRTlCLE1BQU0sV0FBVyxHQUFHLENBQUMsS0FBYyxFQUFzQixFQUFFLENBQ3pELElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsQ0FBQTtBQUV2QixNQUFNLGNBQWMsR0FBRyxDQUNyQixRQUFnQixFQUNoQixNQUlFLEVBQ00sRUFBRSxDQUNWLFFBQVE7S0FDTCxVQUFVLENBQUMsV0FBVyxFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUM7S0FDdEMsVUFBVSxDQUFDLGNBQWMsRUFBRSxNQUFNLENBQUMsU0FBUyxDQUFDO0tBQzVDLFVBQVUsQ0FBQyxjQUFjLEVBQUUsTUFBTSxDQUFDLFNBQVMsSUFBSSxFQUFFLENBQUM7S0FDbEQsSUFBSSxFQUFFO0tBQ04sS0FBSyxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQTtBQUVsQixNQUFNLGFBQWEsR0FBRyxDQUNwQixRQUE0QixFQUM1QixNQUF1RCxFQUNuQyxFQUFFO0lBQ3RCLElBQUksQ0FBQyxRQUFRO1FBQUUsT0FBTyxTQUFTLENBQUE7SUFDL0IsTUFBTSxRQUFRLEdBQUcsUUFBUTtTQUN0QixVQUFVLENBQUMsV0FBVyxFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUM7U0FDdEMsVUFBVSxDQUFDLGNBQWMsRUFB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