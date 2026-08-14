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
        const integrationId = brandSettings?.integrationId ?? this.options_.integrationId;
        const returnUrl = substituteUrl(brandSettings?.returnUrl ?? this.options_.returnUrl, { cartId, sessionId });
        const failureUrl = substituteUrl(brandSettings?.failureUrl ?? this.options_.failureUrl, { cartId, sessionId });
        if (!returnUrl) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Niftipay has no return URL configured for brand ${brandSlug ?? "default"}`);
        }
        const description = renderTemplate(brandSettings?.descriptionTemplate ?? this.options_.descriptionTemplate, { cartId, sessionId, brandSlug });
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
    webhookSecretForSession(session) {
        const brandSlug = (0, utils_2.optionalString)(session.data?.brand_slug);
        return ((brandSlug
            ? this.options_.brandSettings?.[brandSlug]?.webhookSecret
            : undefined) ?? this.options_.webhookSecret);
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
            const authenticated = (0, webhook_1.verifyNiftipayWebhook)({
                rawBody,
                headers: payload.headers ?? {},
                data: payload.data,
                options: {
                    secret: this.webhookSecretForSession(session),
                    toleranceSeconds: this.options_.webhookToleranceSeconds,
                    allowLegacy: this.options_.allowLegacyWebhookAuth,
                },
            });
            if (!authenticated) {
                this.logger_.warn("[niftipay] rejected webhook authentication");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvbmlmdGlwYXkvc2VydmljZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLHFEQUttQztBQTBCbkMsNkRBQWtFO0FBQ2xFLDJEQUErRDtBQUMvRCxtRUFBK0U7QUFLL0UsMkRBSXlDO0FBQ3pDLCtEQUEwRTtBQUMxRSx1Q0FLbUI7QUFDbkIsbURBQWdGO0FBd0JoRixNQUFNLFdBQVcsR0FBRyxDQUFDLEtBQWMsRUFBMkIsRUFBRSxDQUM5RCxJQUFBLGdCQUFRLEVBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0FBRS9CLE1BQU0sV0FBVyxHQUFHLENBQUMsS0FBYyxFQUFzQixFQUFFLENBQ3pELElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsQ0FBQztBQUV4QixNQUFNLGNBQWMsR0FBRyxDQUNyQixRQUFnQixFQUNoQixNQUlFLEVBQ00sRUFBRSxDQUNWLFFBQVE7S0FDTCxVQUFVLENBQUMsV0FBVyxFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUM7S0FDdEMsVUFBVSxDQUFDLGNBQWMsRUFBRSxNQUFNLENBQUMsU0FBUyxDQUFDO0tBQzVDLFVBQVUsQ0FBQyxjQUFjLEVBQUUsTUFBTSxDQUFDLFNBQVMsSUFBSSxFQUFFLENBQUM7S0FDbEQsSUFBSSxFQUFFO0tBQ04sS0FBSyxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQztBQUVuQixNQUFNLGFBQWEsR0FBRyxDQUNwQixRQUE0QixFQUM1QixNQUF1RCxFQUNuQyxFQUFFO0lBQ3RCLElBQUksQ0FBQyxRQUFRO1FBQUUsT0FBTyxTQUFTLENBQUM7SUFDaEMsTUFBTSxRQUFRLEdBQUcsUUFBUTtTQUN0QixVQUFVLENBQUMsV0FBVyxFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUM7U0FDdEMsVUFBVSxDQUFDLGNBQWMsRUFB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