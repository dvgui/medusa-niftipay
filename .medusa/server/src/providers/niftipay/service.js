"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("@medusajs/framework/utils");
const client_1 = require("../../lib/niftipay-client/client");
const buyer_1 = require("../../lib/niftipay-client/buyer");
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
const safeResolve = (container, keys) => {
    for (const key of keys) {
        try {
            const value = container[key];
            if (value != null)
                return value;
        }
        catch {
            // Awilix cradle proxies throw for registrations absent from this scope.
        }
    }
    return undefined;
};
const refundOrderMatchesPayment = (data, remote) => {
    const storedOrderId = (0, utils_2.optionalString)(data.niftipay_order_id);
    const storedIntegrationId = (0, utils_2.optionalString)(data.niftipay_integration_id);
    const storedCurrency = (0, utils_2.optionalString)(data.niftipay_currency)?.toUpperCase();
    // The plugin has used two merchantReference conventions: the cart id and the
    // payment session id. Live data is mixed — 340 of 474 payments store a cart
    // id locally while Niftipay holds the session id for the same order — so
    // demanding one exact value refuses legitimate refunds. Accept any reference
    // that is demonstrably ours; identity is already pinned by the order UUID,
    // integration, and currency checks above, and a foreign reference still fails.
    const acceptableReferences = new Set([
        (0, utils_2.optionalString)(data.niftipay_merchant_reference),
        (0, utils_2.optionalString)(data.session_id),
        (0, utils_2.optionalString)(data.cart_id),
        (0, utils_2.optionalString)(data.niftipay_attempt_id),
    ].filter((reference) => Boolean(reference)));
    return !((storedOrderId && remote.id !== storedOrderId) ||
        (storedIntegrationId &&
            remote.integrationId !== storedIntegrationId) ||
        (storedCurrency && remote.currency !== storedCurrency) ||
        (acceptableReferences.size > 0 &&
            remote.merchantReference !== undefined &&
            !acceptableReferences.has(remote.merchantReference)));
};
const requireRefundableOrder = (remote) => {
    if (!remote.orderKey) {
        throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, "Niftipay refund target has no canonical order key");
    }
    if (!remote.pspOrderId) {
        throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, "Niftipay has no processor order record for this payment; contact Niftipay support with the public order ID and order key");
    }
    if (remote.pspTransactionCount !== undefined &&
        remote.pspTransactionCount <= 0) {
        throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, "Niftipay has no processor transaction record for this payment; contact Niftipay support with the public order ID and order key");
    }
    return {
        ...remote,
        orderKey: remote.orderKey,
        pspOrderId: remote.pspOrderId,
    };
};
/** Infrastructure failures must escape the provider so Medusa retries the
 * queued webhook instead of acknowledging a paid event as unsupported. */
class RetryableNiftipayWebhookError extends Error {
    constructor() {
        super(...arguments);
        this.name = "RetryableNiftipayWebhookError";
    }
}
class NiftipayPaymentProviderService extends utils_1.AbstractPaymentProvider {
    static validateOptions(options) {
        (0, options_1.validateNiftipayOptions)(options);
    }
    constructor(container, options) {
        super(container, options);
        this.verifiedSessions_ = new Map();
        this.logger_ = container.logger;
        this.container_ = container;
        this.options_ = (0, options_1.withDefaults)(options);
        this.store_ = new session_store_1.NiftipaySessionStore(container, container.logger);
    }
    clientForCredentials(credentials) {
        return new client_1.NiftipayClient({
            apiKey: credentials.apiKey,
            baseUrl: this.options_.baseUrl,
            allowedRedirectHosts: this.options_.allowedRedirectHosts,
        });
    }
    credentialsForData(data) {
        const storedIntegrationId = (0, utils_2.optionalString)(data.niftipay_integration_id);
        if (storedIntegrationId) {
            const storedCredentials = (0, options_1.resolveNiftipayCredentialsForIntegration)(this.options_, storedIntegrationId);
            if (storedCredentials)
                return storedCredentials;
        }
        return (0, options_1.resolveNiftipayCredentialsForBrand)(this.options_, (0, utils_2.optionalString)(data.brand_slug));
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
        const attemptId = (0, utils_2.optionalString)(data.niftipay_attempt_id);
        if (attemptId && !/^npat_[A-Za-z0-9]+$/.test(attemptId)) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Niftipay payment attempt ID is invalid");
        }
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
        // Niftipay enforces UNIQUENESS on `reference`. An attempt id is unique per
        // attempt, so when we have one it can safely go in both fields (production
        // data shows Niftipay can echo `reference` back as merchantReference, and
        // one value removes that ambiguity).
        //
        // Without an attempt id the old fallback put the CART id in `reference`,
        // which repeats across retries: the first card attempt on a cart created
        // the order, and every retry was rejected with "Reference already exists",
        // surfacing to the customer as "Card payment is temporarily unavailable".
        // Nothing currently mints `npat_` ids, so that path was always taken.
        // Keep the durable cart id in merchantReference for webhook mapping, and
        // use the per-attempt session id for the field that must be unique.
        const durableReference = attemptId ?? cartId;
        const uniqueReference = attemptId ?? sessionId;
        // Cardholder details help the processor's fraud checks; only what we can
        // state with certainty is sent (see lib/niftipay-client/buyer).
        const buyer = (0, buyer_1.niftipayBuyerDetails)({
            billingAddress: paymentData(data.billing_address),
            shippingAddress: paymentData(data.shipping_address),
            customerName,
            customerPhone: customerContext.phone ?? data.phone,
        });
        const payload = {
            integrationId,
            currency,
            amount,
            email,
            description,
            reference: uniqueReference,
            merchantReference: durableReference,
            serviceFeePayer,
            ...buyer,
            ...(returnUrl ? { returnUrl } : {}),
            ...(failureUrl ? { failureUrl } : {}),
        };
        try {
            const created = await this.clientForCredentials(credentials).createFiatOrder(payload);
            const acceptableReturnedReferences = attemptId
                ? new Set([durableReference])
                : new Set([durableReference, sessionId, cartId]);
            if (created.reference &&
                !acceptableReturnedReferences.has(created.reference)) {
                throw new Error("Niftipay returned a different merchant reference");
            }
            const sessionData = {
                session_id: sessionId,
                cart_id: cartId,
                ...(attemptId ? { niftipay_attempt_id: attemptId } : {}),
                ...(brandSlug ? { brand_slug: brandSlug } : {}),
                niftipay_order_id: created.orderId,
                niftipay_order_key: created.orderKey,
                niftipay_redirect_url: created.payUrl,
                niftipay_reference: uniqueReference,
                niftipay_merchant_reference: durableReference,
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
    async resolveRefundOrder(data, client) {
        const storedOrderId = (0, utils_2.optionalString)(data.niftipay_order_id);
        const storedOrderKey = (0, utils_2.optionalString)(data.niftipay_order_key);
        const candidates = [...new Set([storedOrderId, storedOrderKey])].filter((candidate) => Boolean(candidate));
        if (candidates.length === 0) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Niftipay public order ID or order key is required for refund");
        }
        let remote;
        let lookupError;
        for (const candidate of candidates) {
            try {
                remote = await client.retrieveNormalizedFiatOrder(candidate);
                break;
            }
            catch (error) {
                lookupError = error;
            }
        }
        if (!remote) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, `Niftipay could not resolve the stored refund target: ${(0, utils_2.getErrorMessage)(lookupError)}`);
        }
        if (!refundOrderMatchesPayment(data, remote)) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, "Niftipay refund target does not match the captured Medusa payment");
        }
        return requireRefundableOrder(remote);
    }
    async refundPayment(input) {
        const data = paymentData(input.data);
        const amount = numberValue(input.amount);
        const currency = (0, utils_2.optionalString)(data.niftipay_currency);
        if (amount === undefined || !currency) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Niftipay refund amount and currency are required");
        }
        const client = this.clientForCredentials(this.credentialsForData(data));
        const remote = await this.resolveRefundOrder(data, client);
        const identifier = remote.orderKey;
        const amountCents = (0, money_1.toMinorUnits)(amount, currency);
        try {
            await client.createFiatRefund(identifier, {
                amountCents,
                description: `Medusa refund for ${(0, utils_2.optionalString)(data.session_id) ?? identifier}`,
            });
        }
        catch (error) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, `Niftipay refund request failed for order ${remote.id ?? identifier}: ${(0, utils_2.getErrorMessage)(error)}`);
        }
        return {
            data: {
                ...data,
                ...(remote.id ? { niftipay_order_id: remote.id } : {}),
                niftipay_order_key: identifier,
                niftipay_psp_order_id: remote.pspOrderId,
                ...(remote.pspStatus
                    ? { niftipay_psp_status: remote.pspStatus }
                    : {}),
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
        const remote = await this.clientForCredentials(this.credentialsForData(data)).retrieveNormalizedFiatOrder(identifier);
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
    async resolveSession(orderKey, merchantReference, orderId) {
        if (merchantReference?.startsWith("payses_")) {
            const session = await this.store_.load(merchantReference);
            if (session)
                return session;
        }
        if (merchantReference?.startsWith("cart_")) {
            const session = await this.store_.findByCartId(merchantReference, orderId);
            if (session)
                return session;
        }
        if (merchantReference?.startsWith("npat_")) {
            const session = await this.store_.findByAttemptId(merchantReference, orderId);
            if (session)
                return session;
        }
        return orderKey ? this.store_.findByOrderKey(orderKey) : null;
    }
    credentialsForSession(session) {
        return this.credentialsForData(session.data ?? {});
    }
    /**
     * Emits an app-owned recovery event only after the webhook has passed the
     * integration-bound HMAC check. The remote status lookup is mandatory; an
     * outage throws so Medusa's queued webhook retries instead of accepting an
     * unverified recovery.
     */
    async emitOrphanPaid(webhook, credentials) {
        const signed = webhook.order;
        const durableReference = signed.merchantReference ?? signed.reference;
        const cartId = durableReference?.startsWith("cart_")
            ? durableReference
            : undefined;
        const attemptId = durableReference?.startsWith("npat_")
            ? durableReference
            : undefined;
        if (webhook.event !== "paid" || (!cartId && !attemptId)) {
            if (webhook.event === "paid") {
                this.logger_.error(`[niftipay] authenticated orphan paid webhook has no durable reference (orderId=${signed.id ?? "unknown"}, reference=${durableReference ?? "unknown"}); manual recovery required`);
            }
            return false;
        }
        if (!signed.id || !signed.integrationId) {
            this.logger_.error("[niftipay] authenticated orphan paid webhook is missing order or integration ID");
            return false;
        }
        let canonical = signed;
        try {
            const remote = await this.clientForCredentials(credentials).retrieveNormalizedFiatOrder(signed.id);
            if (!remote.id || remote.id !== signed.id) {
                this.logger_.error(`[niftipay] orphan status lookup returned a different public order ID for ${signed.id}`);
                return false;
            }
            if (!["completed", "paid"].includes(remote.status ?? "")) {
                throw new RetryableNiftipayWebhookError(`Niftipay status lookup is not completed for ${signed.id} (status=${remote.status ?? "unknown"})`);
            }
            canonical = remote;
        }
        catch (error) {
            if (error instanceof RetryableNiftipayWebhookError)
                throw error;
            const message = error instanceof Error ? error.message : String(error);
            throw new RetryableNiftipayWebhookError(`Niftipay orphan status lookup failed for ${signed.id}: ${message}`);
        }
        if (canonical.integrationId &&
            canonical.integrationId !== signed.integrationId) {
            this.logger_.error(`[niftipay] orphan integration mismatch for ${signed.id}`);
            return false;
        }
        if (canonical.merchantReference &&
            canonical.merchantReference !== durableReference) {
            this.logger_.error(`[niftipay] orphan merchant reference mismatch for ${signed.id}`);
            return false;
        }
        const currency = canonical.currency ?? signed.currency;
        if (!currency || (signed.currency && currency !== signed.currency)) {
            this.logger_.error(`[niftipay] orphan currency is missing or inconsistent for ${signed.id}`);
            return false;
        }
        const amountMinor = canonical.subtotalCents ??
            canonical.amountCents ??
            signed.subtotalCents ??
            signed.amountCents;
        if (!Number.isSafeInteger(amountMinor) || Number(amountMinor) <= 0) {
            this.logger_.error(`[niftipay] orphan amount is missing or invalid for ${signed.id}`);
            return false;
        }
        const signedAmounts = [signed.subtotalCents, signed.amountCents].filter((value) => value !== undefined);
        if (signedAmounts.length > 0 &&
            !signedAmounts.some((value) => Math.round(value) === amountMinor)) {
            this.logger_.error(`[niftipay] orphan amount mismatch for ${signed.id}`);
            return false;
        }
        const customerEmail = canonical.email ?? signed.email;
        if (!customerEmail) {
            this.logger_.error(`[niftipay] orphan order ${signed.id} has no customer email; manual recovery required`);
            return false;
        }
        const capturedAtIso = canonical.completedAt ??
            canonical.updatedAt ??
            signed.completedAt ??
            signed.updatedAt ??
            new Date().toISOString();
        const eventBus = safeResolve(this.container_, [
            utils_1.Modules.EVENT_BUS,
            "eventBusService",
            "__event_bus__",
        ]);
        if (!eventBus) {
            throw new RetryableNiftipayWebhookError(`Niftipay event bus unavailable for orphan ${signed.id}`);
        }
        try {
            await eventBus.emit({
                name: "payment.niftipay_orphan_paid",
                data: {
                    ...(cartId ? { cartId } : {}),
                    ...(attemptId ? { attemptId } : {}),
                    niftipayOrderId: signed.id,
                    ...(canonical.orderKey ?? signed.orderKey
                        ? { niftipayOrderKey: canonical.orderKey ?? signed.orderKey }
                        : {}),
                    merchantReference: durableReference,
                    amountMinor,
                    currencyCode: currency,
                    customerEmail,
                    capturedAtIso,
                    integrationId: signed.integrationId,
                    ...(signed.reference?.startsWith("payses_")
                        ? { missingSessionId: signed.reference }
                        : {}),
                },
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new RetryableNiftipayWebhookError(`Niftipay orphan event dispatch failed for ${signed.id}: ${message}`);
        }
        this.logger_.warn(`[niftipay] emitted payment.niftipay_orphan_paid for order ${signed.id} reference=${durableReference}`);
        return true;
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
            const webhookIntegrationId = webhook.kind === "payment"
                ? webhook.order.integrationId
                : webhook.integrationId;
            const webhookCredentials = webhookIntegrationId
                ? (0, options_1.resolveNiftipayCredentialsForIntegration)(this.options_, webhookIntegrationId)
                : undefined;
            if (webhookIntegrationId && !webhookCredentials) {
                this.logger_.warn("[niftipay] rejected webhook for an unknown integration");
                return unsupported;
            }
            const session = await this.resolveSession(webhook.kind === "payment" ? webhook.order.orderKey : undefined, webhook.kind === "payment"
                ? (webhook.order.merchantReference ?? webhook.order.reference)
                : webhook.merchantReference, webhook.kind === "payment" ? webhook.order.id : undefined);
            if (!session || session.deleted_at || session.status === "canceled") {
                const event = webhook.kind === "payment" ? webhook.event : "risk_alert";
                const orderId = webhook.kind === "payment" ? webhook.order.id : undefined;
                if (!webhookCredentials) {
                    this.logger_.error(`[niftipay] ${event} webhook has no live session or integration-bound credentials (orderId=${orderId ?? "unknown"}); cannot authenticate orphan recovery`);
                    return unsupported;
                }
                const auth = (0, webhook_1.verifyNiftipayWebhookDetailed)({
                    rawBody,
                    headers: payload.headers ?? {},
                    data: payload.data,
                    options: {
                        secret: webhookCredentials.webhookSecret,
                        toleranceSeconds: this.options_.webhookToleranceSeconds,
                        allowLegacy: this.options_.allowLegacyWebhookAuth,
                    },
                });
                if (!auth.ok) {
                    // This is the orphan path: the session is gone, so a rejection here
                    // means emitOrphanPaid never runs and the payment is stranded. Say
                    // exactly why, or it cannot be triaged after the fact.
                    this.logger_.warn(`[niftipay] rejected webhook authentication (orphan path) reason=${auth.reason}` +
                        `${auth.detail ? ` ${auth.detail}` : ""} event=${event} orderId=${orderId ?? "unknown"}` +
                        ` integrationId=${webhookCredentials.integrationId ?? "unknown"}`);
                    return unsupported;
                }
                this.logger_.warn(`[niftipay] ${event} webhook has no live payment session (orderId=${orderId ?? "unknown"})`);
                if (webhook.kind === "payment" && webhook.event === "paid") {
                    await this.emitOrphanPaid(webhook, webhookCredentials);
                }
                return unsupported;
            }
            const sessionCredentials = this.credentialsForSession(session);
            const auth = (0, webhook_1.verifyNiftipayWebhookDetailed)({
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
            if (!auth.ok) {
                this.logger_.warn(`[niftipay] rejected webhook authentication (live session) reason=${auth.reason}` +
                    `${auth.detail ? ` ${auth.detail}` : ""} session=${session.id}` +
                    ` integrationId=${sessionCredentials.integrationId ?? "unknown"}`);
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
            const storedMerchantReference = (0, utils_2.optionalString)(sessionData.niftipay_merchant_reference) ?? session.id;
            const referenceMatches = webhookReference === session.id ||
                webhookReference === storedMerchantReference;
            if ((webhookReference && !referenceMatches) ||
                (webhook.event === "paid" && !referenceMatches)) {
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
            if (error instanceof RetryableNiftipayWebhookError)
                throw error;
            return unsupported;
        }
    }
}
NiftipayPaymentProviderService.identifier = "niftipay";
exports.default = NiftipayPaymentProviderService;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvbmlmdGlwYXkvc2VydmljZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLHFEQU1tQztBQTBCbkMsNkRBQWtFO0FBQ2xFLDJEQUF1RTtBQUN2RSwyREFBK0Q7QUFDL0QsbUVBQStFO0FBTy9FLDJEQUt5QztBQUN6QywrREFBa0Y7QUFDbEYsdUNBUW1CO0FBQ25CLG1EQUFnRjtBQTJCaEYsTUFBTSxXQUFXLEdBQUcsQ0FBQyxLQUFjLEVBQTJCLEVBQUUsQ0FDOUQsSUFBQSxnQkFBUSxFQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztBQUUvQixNQUFNLFdBQVcsR0FBRyxDQUFDLEtBQWMsRUFBc0IsRUFBRSxDQUN6RCxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLENBQUM7QUFFeEIsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLEtBQWMsRUFBc0IsRUFBRSxDQUNwRSxJQUFBLHNCQUFjLEVBQUMsS0FBSyxDQUFDLEVBQUUsT0FBTyxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBRTVELE1BQU0sY0FBYyxHQUFHLENBQ3JCLFFBQWdCLEVBQ2hCLE1BS0UsRUFDTSxFQUFFLENBQ1YsUUFBUTtLQUNMLFVBQVUsQ0FBQyxXQUFXLEVBQUUsTUFBTSxDQUFDLE1BQU0sQ0FBQztLQUN0QyxVQUFVLENBQUMsY0FBYyxFQUFFLE1BQU0sQ0FBQyxTQUFTLENBQUM7S0FDNUMsVUFBVSxDQUFDLGNBQWMsRUFBRSxNQUFNLENBQUMsU0FBUyxJQUFJLEVBQUUsQ0FBQztLQUNsRCxVQUFVLENBQUMsaUJBQWlCLEVBQUUsTUFBTSxDQUFDLFlBQVksSUFBSSxFQUFFLENBQUM7S0FDeEQsT0FBTyxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUM7S0FDcEIsSUFBSSxFQUFFO0tBQ04sS0FBSyxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQztBQUVuQixNQUFNLGFBQWEsR0FBRyxDQUNwQixRQUE0QixFQUM1QixNQUF1RCxFQUNuQyxFQUFFO0lBQ3RCLElBQUksQ0FBQyxRQUFRO1FBQUUsT0FBTyxTQUFTLENBQUM7SUFDaEMsTUFBTSxRQUFRLEdBQUcsUUFBUTtTQUN0QixVQUFVLENBQUMsV0FBVyxFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUM7U0FDdEMsVUFBVSxDQUFDLGNBQWMsRUFBRSxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDaEQsTUFBTSxNQUFNLEdBQUcsSUFBSSxHQUFHLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDakMsSUFBSSxNQUFNLENBQUMsUUFBUSxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQ2pDLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLGlEQUFpRCxDQUNsRCxDQUFDO0lBQ0osQ0FBQztJQUNELE9BQU8sTUFBTSxDQUFDLFFBQVEsRUFBRSxDQUFDO0FBQzNCLENBQUMsQ0FBQztBQUVGLE1BQU0sa0JBQWtCLEdBQUcsQ0FBQyxLQUFhLEVBQVUsRUFBRSxDQUFDLEtBQUssQ0FBQyxXQUFXLEVBQUUsQ0FBQztBQUUxRSxNQUFNLFdBQVcsR0FBRyxDQUNsQixTQUFrQyxFQUNsQyxJQUF1QixFQUNSLEVBQUU7SUFDakIsS0FBSyxNQUFNLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztRQUN2QixJQUFJLENBQUM7WUFDSCxNQUFNLEtBQUssR0FBRyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDN0IsSUFBSSxLQUFLLElBQUksSUFBSTtnQkFBRSxPQUFPLEtBQVUsQ0FBQztRQUN2QyxDQUFDO1FBQUMsTUFBTSxDQUFDO1lBQ1Asd0VBQXdFO1FBQzFFLENBQUM7SUFDSCxDQUFDO0lBQ0QsT0FBTyxTQUFTLENBQUM7QUFDbkIsQ0FBQyxDQUFDO0FBYUYsTUFBTSx5QkFBeUIsR0FBRyxDQUNoQyxJQUE2QixFQUM3QixNQUEyQixFQUNsQixFQUFFO0lBQ1gsTUFBTSxhQUFhLEdBQUcsSUFBQSxzQkFBYyxFQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO0lBQzdELE1BQU0sbUJBQW1CLEdBQUcsSUFBQSxzQkFBYyxFQUN4QyxJQUFJLENBQUMsdUJBQXVCLENBQzdCLENBQUM7SUFDRixNQUFNLGNBQWMsR0FBRyxJQUFBLHNCQUFjLEVBQ25DLElBQUksQ0FBQyxpQkFBaUIsQ0FDdkIsRUFBRSxXQUFXLEVBQUUsQ0FBQztJQUNqQiw2RUFBNkU7SUFDN0UsNEVBQTRFO0lBQzVFLHlFQUF5RTtJQUN6RSw2RUFBNkU7SUFDN0UsMkVBQTJFO0lBQzNFLCtFQUErRTtJQUMvRSxNQUFNLG9CQUFvQixHQUFHLElBQUksR0FBRyxDQUNsQztRQUNFLElBQUEsc0JBQWMsRUFBQyxJQUFJLENBQUMsMkJBQTJCLENBQUM7UUFDaEQsSUFBQSxzQkFBYyxFQUFDLElBQUksQ0FBQyxVQUFVLENBQUM7UUFDL0IsSUFBQSxzQkFBYyxFQUFDLElBQUksQ0FBQyxPQUFPLENBQUM7UUFDNUIsSUFBQSxzQkFBYyxFQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQztLQUN6QyxDQUFDLE1BQU0sQ0FBQyxDQUFDLFNBQVMsRUFBdUIsRUFBRSxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUNqRSxDQUFDO0lBRUYsT0FBTyxDQUFDLENBQ04sQ0FBQyxhQUFhLElBQUksTUFBTSxDQUFDLEVBQUUsS0FBSyxhQUFhLENBQUM7UUFDOUMsQ0FBQyxtQkFBbUI7WUFDbEIsTUFBTSxDQUFDLGFBQWEsS0FBSyxtQkFBbUIsQ0FBQztRQUMvQyxDQUFDLGNBQWMsSUFBSSxNQUFNLENBQUMsUUFBUSxLQUFLLGNBQWMsQ0FBQztRQUN0RCxDQUFDLG9CQUFvQixDQUFDLElBQUksR0FBRyxDQUFDO1lBQzVCLE1BQU0sQ0FBQyxpQkFBaUIsS0FBSyxTQUFTO1lBQ3RDLENBQUMsb0JBQW9CLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLENBQ3ZELENBQUM7QUFDSixDQUFDLENBQUM7QUFFRixNQUFNLHNCQUFzQixHQUFHLENBQzdCLE1BQTJCLEVBQ0YsRUFBRTtJQUMzQixJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBQ3JCLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxnQkFBZ0IsRUFDbEMsbURBQW1ELENBQ3BELENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxDQUFDLE1BQU0sQ0FBQyxVQUFVLEVBQUUsQ0FBQztRQUN2QixNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLEVBQ2xDLDBIQUEwSCxDQUMzSCxDQUFDO0lBQ0osQ0FBQztJQUNELElBQ0UsTUFBTSxDQUFDLG1CQUFtQixLQUFLLFNBQVM7UUFDeEMsTUFBTSxDQUFDLG1CQUFtQixJQUFJLENBQUMsRUFDL0IsQ0FBQztRQUNELE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxnQkFBZ0IsRUFDbEMsZ0lBQWdJLENBQ2pJLENBQUM7SUFDSixDQUFDO0lBRUQsT0FBTztRQUNMLEdBQUcsTUFBTTtRQUNULFFBQVEsRUFBRSxNQUFNLENBQUMsUUFBUTtRQUN6QixVQUFVLEVBQUUsTUFBTSxDQUFDLFVBQVU7S0FDOUIsQ0FBQztBQUNKLENBQUMsQ0FBQztBQVNGOzBFQUMwRTtBQUMxRSxNQUFNLDZCQUE4QixTQUFRLEtBQUs7SUFBakQ7O1FBQ1csU0FBSSxHQUFHLCtCQUErQixDQUFDO0lBQ2xELENBQUM7Q0FBQTtBQUVELE1BQU0sOEJBQStCLFNBQVEsK0JBQWdEO0lBUzNGLE1BQU0sQ0FBQyxlQUFlLENBQUMsT0FBZ0M7UUFDckQsSUFBQSxpQ0FBdUIsRUFBQyxPQUFPLENBQUMsQ0FBQztJQUNuQyxDQUFDO0lBRUQsWUFDRSxTQUErQixFQUMvQixPQUFnQztRQUVoQyxLQUFLLENBQUMsU0FBUyxFQUFFLE9BQU8sQ0FBQyxDQUFDO1FBVlgsc0JBQWlCLEdBQUcsSUFBSSxHQUFHLEVBQWtCLENBQUM7UUFXN0QsSUFBSSxDQUFDLE9BQU8sR0FBRyxTQUFTLENBQUMsTUFBTSxDQUFDO1FBQ2hDLElBQUksQ0FBQyxVQUFVLEdBQUcsU0FBUyxDQUFDO1FBQzVCLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBQSxzQkFBWSxFQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ3RDLElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxvQ0FBb0IsQ0FBQyxTQUFTLEVBQUUsU0FBUyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3RFLENBQUM7SUFFTyxvQkFBb0IsQ0FDMUIsV0FBd0M7UUFFeEMsT0FBTyxJQUFJLHVCQUFjLENBQUM7WUFDeEIsTUFBTSxFQUFFLFdBQVcsQ0FBQyxNQUFNO1lBQzFCLE9BQU8sRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLE9BQU87WUFDOUIsb0JBQW9CLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxvQkFBb0I7U0FDekQsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVPLGtCQUFrQixDQUN4QixJQUE2QjtRQUU3QixNQUFNLG1CQUFtQixHQUFHLElBQUEsc0JBQWMsRUFDeEMsSUFBSSxDQUFDLHVCQUF1QixDQUM3QixDQUFDO1FBQ0YsSUFBSSxtQkFBbUIsRUFBRSxDQUFDO1lBQ3hCLE1BQU0saUJBQWlCLEdBQUcsSUFBQSxrREFBd0MsRUFDaEUsSUFBSSxDQUFDLFFBQVEsRUFDYixtQkFBbUIsQ0FDcEIsQ0FBQztZQUNGLElBQUksaUJBQWlCO2dCQUFFLE9BQU8saUJBQWlCLENBQUM7UUFDbEQsQ0FBQztRQUVELE9BQU8sSUFBQSw0Q0FBa0MsRUFDdkMsSUFBSSxDQUFDLFFBQVEsRUFDYixJQUFBLHNCQUFjLEVBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUNoQyxDQUFDO0lBQ0osQ0FBQztJQUVPLGtCQUFrQixDQUFDLFNBQWlCO1FBQzFDLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDekQsSUFBSSxDQUFDLFVBQVU7WUFBRSxPQUFPLEtBQUssQ0FBQztRQUM5QixJQUFJLElBQUksQ0FBQyxHQUFHLEVBQUUsR0FBRyxVQUFVLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQyxhQUFhLEVBQUUsQ0FBQztZQUMxRCxJQUFJLENBQUMsaUJBQWlCLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1lBQ3pDLE9BQU8sS0FBSyxDQUFDO1FBQ2YsQ0FBQztRQUNELE9BQU8sSUFBSSxDQUFDO0lBQ2QsQ0FBQztJQUVELEtBQUssQ0FBQyxlQUFlLENBQ25CLEtBQTJCO1FBRTNCLE1BQU0sSUFBSSxHQUFHLFdBQVcsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDckMsTUFBTSxTQUFTLEdBQUcsSUFBQSxzQkFBYyxFQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDeEQsTUFBTSxNQUFNLEdBQUcsSUFBQSxzQkFBYyxFQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDbEQsTUFBTSxNQUFNLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUN6QyxNQUFNLFFBQVEsR0FBRyxrQkFBa0IsQ0FBQyxLQUFLLENBQUMsYUFBYSxJQUFJLEtBQUssQ0FBQyxDQUFDO1FBQ2xFLE1BQU0sS0FBSyxHQUNULElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsT0FBTyxFQUFFLFFBQVEsRUFBRSxLQUFLLENBQUM7WUFDOUMsSUFBQSxzQkFBYyxFQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUM3QixNQUFNLGVBQWUsR0FBRyxXQUFXLENBQUMsS0FBSyxDQUFDLE9BQU8sRUFBRSxRQUFRLENBQUMsQ0FBQztRQUM3RCxNQUFNLG1CQUFtQixHQUFHLHNCQUFzQixDQUNoRDtZQUNFLElBQUEsc0JBQWMsRUFBQyxlQUFlLENBQUMsVUFBVSxDQUFDO1lBQzFDLElBQUEsc0JBQWMsRUFBQyxlQUFlLENBQUMsU0FBUyxDQUFDO1NBQzFDO2FBQ0UsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFrQixFQUFFLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO2FBQy9DLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FDYixDQUFDO1FBQ0YsTUFBTSxZQUFZLEdBQ2hCLHNCQUFzQixDQUFDLElBQUksQ0FBQyxhQUFhLENBQUM7WUFDMUMsc0JBQXNCLENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQztZQUM1QyxtQkFBbUIsQ0FBQztRQUV0QixJQUFJLENBQUMsdUJBQXVCLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7WUFDN0MsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsbURBQW1ELENBQ3BELENBQUM7UUFDSixDQUFDO1FBQ0QsSUFBSSxDQUFDLHFCQUFxQixDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1lBQ3hDLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLDhEQUE4RCxDQUMvRCxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksTUFBTSxLQUFLLFNBQVMsSUFBSSxNQUFNLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDeEMsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsbURBQW1ELENBQ3BELENBQUM7UUFDSixDQUFDO1FBQ0QsSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ1gsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsNENBQTRDLENBQzdDLENBQUM7UUFDSixDQUFDO1FBRUQsTUFBTSxpQkFBaUIsR0FBRyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsaUJBQWlCLElBQUksRUFBRSxDQUFDLENBQUMsR0FBRyxDQUNuRSxrQkFBa0IsQ0FDbkIsQ0FBQztRQUNGLElBQUksaUJBQWlCLENBQUMsTUFBTSxHQUFHLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO1lBQzFFLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLDJCQUEyQixRQUFRLFdBQVcsQ0FDL0MsQ0FBQztRQUNKLENBQUM7UUFFRCwwRUFBMEU7UUFDMUUsSUFBQSxvQkFBWSxFQUFDLE1BQU0sRUFBRSxRQUFRLENBQUMsQ0FBQztRQUUvQixNQUFNLGVBQWUsR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQztRQUN0RCxNQUFNLFNBQVMsR0FBRyxJQUFBLHNCQUFjLEVBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLENBQUM7UUFDM0QsSUFBSSxTQUFTLElBQUksQ0FBQyxxQkFBcUIsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztZQUN4RCxNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUM5Qix3Q0FBd0MsQ0FDekMsQ0FBQztRQUNKLENBQUM7UUFDRCxNQUFNLFNBQVMsR0FDYixJQUFBLHNCQUFjLEVBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDO1lBQ3hDLElBQUEsc0JBQWMsRUFBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDbEMsTUFBTSxhQUFhLEdBQUcsU0FBUztZQUM3QixDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxhQUFhLEVBQUUsQ0FBQyxTQUFTLENBQUM7WUFDMUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztRQUNkLE1BQU0sV0FBVyxHQUFHLElBQUEsNENBQWtDLEVBQ3BELElBQUksQ0FBQyxRQUFRLEVBQ2IsU0FBUyxDQUNWLENBQUM7UUFDRixNQUFNLGFBQWEsR0FBRyxXQUFXLENBQUMsYUFBYSxDQUFDO1FBQ2hELE1BQU0sU0FBUyxHQUFHLGFBQWEsQ0FDN0IsYUFBYSxFQUFFLFNBQVMsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLFNBQVMsRUFDbkQsRUFBRSxNQUFNLEVBQUUsU0FBUyxFQUFFLENBQ3RCLENBQUM7UUFDRixNQUFNLFVBQVUsR0FBRyxhQUFhLENBQzlCLGFBQWEsRUFBRSxVQUFVLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxVQUFVLEVBQ3JELEVBQUUsTUFBTSxFQUFFLFNBQVMsRUFBRSxDQUN0QixDQUFDO1FBQ0YsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO1lBQ2YsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsbURBQW1ELFNBQVMsSUFBSSxTQUFTLEVBQUUsQ0FDNUUsQ0FBQztRQUNKLENBQUM7UUFFRCxNQUFNLFdBQVcsR0FBRyxjQUFjLENBQ2hDLGFBQWEsRUFBRSxtQkFBbUIsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLG1CQUFtQixFQUN2RSxFQUFFLE1BQU0sRUFBRSxTQUFTLEVBQUUsU0FBUyxFQUFFLFlBQVksRUFBRSxDQUMvQyxDQUFDO1FBQ0YsMkVBQTJFO1FBQzNFLDJFQUEyRTtRQUMzRSwwRUFBMEU7UUFDMUUscUNBQXFDO1FBQ3JDLEVBQUU7UUFDRix5RUFBeUU7UUFDekUseUVBQXlFO1FBQ3pFLDJFQUEyRTtRQUMzRSwwRUFBMEU7UUFDMUUsc0VBQXNFO1FBQ3RFLHlFQUF5RTtRQUN6RSxvRUFBb0U7UUFDcEUsTUFBTSxnQkFBZ0IsR0FBRyxTQUFTLElBQUksTUFBTSxDQUFDO1FBQzdDLE1BQU0sZUFBZSxHQUFHLFNBQVMsSUFBSSxTQUFTLENBQUM7UUFDL0MseUVBQXlFO1FBQ3pFLGdFQUFnRTtRQUNoRSxNQUFNLEtBQUssR0FBRyxJQUFBLDRCQUFvQixFQUFDO1lBQ2pDLGNBQWMsRUFBRSxXQUFXLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQztZQUNqRCxlQUFlLEVBQUUsV0FBVyxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQztZQUNuRCxZQUFZO1lBQ1osYUFBYSxFQUFFLGVBQWUsQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLEtBQUs7U0FDbkQsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxPQUFPLEdBQTZCO1lBQ3hDLGFBQWE7WUFDYixRQUFRO1lBQ1IsTUFBTTtZQUNOLEtBQUs7WUFDTCxXQUFXO1lBQ1gsU0FBUyxFQUFFLGVBQWU7WUFDMUIsaUJBQWlCLEVBQUUsZ0JBQWdCO1lBQ25DLGVBQWU7WUFDZixHQUFHLEtBQUs7WUFDUixHQUFHLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLFNBQVMsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDbkMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsRUFBRSxVQUFVLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1NBQ3RDLENBQUM7UUFFRixJQUFJLENBQUM7WUFDSCxNQUFNLE9BQU8sR0FBRyxNQUFNLElBQUksQ0FBQyxvQkFBb0IsQ0FDN0MsV0FBVyxDQUNaLENBQUMsZUFBZSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQzNCLE1BQU0sNEJBQTRCLEdBQUcsU0FBUztnQkFDNUMsQ0FBQyxDQUFDLElBQUksR0FBRyxDQUFDLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztnQkFDN0IsQ0FBQyxDQUFDLElBQUksR0FBRyxDQUFDLENBQUMsZ0JBQWdCLEVBQUUsU0FBUyxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUM7WUFDbkQsSUFDRSxPQUFPLENBQUMsU0FBUztnQkFDakIsQ0FBQyw0QkFBNEIsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxFQUNwRCxDQUFDO2dCQUNELE1BQU0sSUFBSSxLQUFLLENBQUMsa0RBQWtELENBQUMsQ0FBQztZQUN0RSxDQUFDO1lBQ0QsTUFBTSxXQUFXLEdBQXdCO2dCQUN2QyxVQUFVLEVBQUUsU0FBUztnQkFDckIsT0FBTyxFQUFFLE1BQU07Z0JBQ2YsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxtQkFBbUIsRUFBRSxTQUFTLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUN4RCxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLFVBQVUsRUFBRSxTQUFTLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUMvQyxpQkFBaUIsRUFBRSxPQUFPLENBQUMsT0FBTztnQkFDbEMsa0JBQWtCLEVBQUUsT0FBTyxDQUFDLFFBQVE7Z0JBQ3BDLHFCQUFxQixFQUFFLE9BQU8sQ0FBQyxNQUFNO2dCQUNyQyxrQkFBa0IsRUFBRSxlQUFlO2dCQUNuQywyQkFBMkIsRUFBRSxnQkFBZ0I7Z0JBQzdDLG9CQUFvQixFQUFFLFdBQVc7Z0JBQ2pDLHVCQUF1QixFQUFFLGFBQWE7Z0JBQ3RDLGVBQWUsRUFBRSxPQUFPLENBQUMsTUFBTSxJQUFJLFNBQVM7Z0JBQzVDLGVBQWUsRUFBRSxNQUFNO2dCQUN2QixpQkFBaUIsRUFBRSxRQUFRO2dCQUMzQixjQUFjLEVBQUUsS0FBSztnQkFDckIsR0FBRyxDQUFDLFlBQVk7b0JBQ2QsQ0FBQyxDQUFDLEVBQUUsc0JBQXNCLEVBQUUsWUFBWSxFQUFFO29CQUMxQyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUNQLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsbUJBQW1CLEVBQUUsU0FBUyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztnQkFDeEQsR0FBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsRUFBRSxvQkFBb0IsRUFBRSxVQUFVLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUMzRCwwQkFBMEIsRUFBRSxlQUFlO2FBQzVDLENBQUM7WUFFRixPQUFPO2dCQUNMLEVBQUUsRUFBRSxPQUFPLENBQUMsUUFBUTtnQkFDcEIsSUFBSSxFQUFFLEVBQUUsR0FBRyxJQUFJLEVBQUUsR0FBRyxXQUFXLEVBQUU7YUFDbEMsQ0FBQztRQUNKLENBQUM7UUFBQyxPQUFPLEtBQWMsRUFBRSxDQUFDO1lBQ3hCLE1BQU0sT0FBTyxHQUFHLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUN2RSxNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLEVBQ2xDLDJDQUEyQyxPQUFPLEVBQUUsQ0FDckQsQ0FBQztRQUNKLENBQUM7SUFDSCxDQUFDO0lBRUQsS0FBSyxDQUFDLGdCQUFnQixDQUNwQixLQUE0QjtRQUU1QixNQUFNLElBQUksR0FBRyxXQUFXLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3JDLE1BQU0sU0FBUyxHQUFHLElBQUEsc0JBQWMsRUFBQyxJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ3hELE1BQU0sTUFBTSxHQUFHLElBQUEsc0JBQWMsRUFBQyxJQUFJLENBQUMsZUFBZSxDQUFDLEVBQUUsV0FBVyxFQUFFLENBQUM7UUFDbkUsTUFBTSxJQUFJLEdBQ1IsTUFBTSxLQUFLLE1BQU07WUFDakIsQ0FBQyxTQUFTLEtBQUssRUFBRSxJQUFJLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDO1FBQzNELE9BQU87WUFDTCxJQUFJO1lBQ0osTUFBTSxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBeUI7U0FDaEUsQ0FBQztJQUNKLENBQUM7SUFFRCxLQUFLLENBQUMsY0FBYyxDQUNsQixLQUEwQjtRQUUxQixPQUFPLEVBQUUsSUFBSSxFQUFFLFdBQVcsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztJQUMzQyxDQUFDO0lBRUQsS0FBSyxDQUFDLGFBQWEsQ0FBQyxLQUF5QjtRQUMzQywwRUFBMEU7UUFDMUUsT0FBTyxFQUFFLElBQUksRUFBRSxXQUFXLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7SUFDM0MsQ0FBQztJQUVELEtBQUssQ0FBQyxhQUFhLENBQUMsS0FBeUI7UUFDM0MsMEVBQTBFO1FBQzFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsV0FBVyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO0lBQzNDLENBQUM7SUFFTyxLQUFLLENBQUMsa0JBQWtCLENBQzlCLElBQTZCLEVBQzdCLE1BQXNCO1FBRXRCLE1BQU0sYUFBYSxHQUFHLElBQUEsc0JBQWMsRUFBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsQ0FBQztRQUM3RCxNQUFNLGNBQWMsR0FBRyxJQUFBLHNCQUFjLEVBQUMsSUFBSSxDQUFDLGtCQUFrQixDQUFDLENBQUM7UUFDL0QsTUFBTSxVQUFVLEdBQUcsQ0FBQyxHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsYUFBYSxFQUFFLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQ3JFLENBQUMsU0FBUyxFQUF1QixFQUFFLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUN2RCxDQUFDO1FBRUYsSUFBSSxVQUFVLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQzVCLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLDhEQUE4RCxDQUMvRCxDQUFDO1FBQ0osQ0FBQztRQUVELElBQUksTUFBdUMsQ0FBQztRQUM1QyxJQUFJLFdBQW9CLENBQUM7UUFDekIsS0FBSyxNQUFNLFNBQVMsSUFBSSxVQUFVLEVBQUUsQ0FBQztZQUNuQyxJQUFJLENBQUM7Z0JBQ0gsTUFBTSxHQUFHLE1BQU0sTUFBTSxDQUFDLDJCQUEyQixDQUFDLFNBQVMsQ0FBQyxDQUFDO2dCQUM3RCxNQUFNO1lBQ1IsQ0FBQztZQUFDLE9BQU8sS0FBYyxFQUFFLENBQUM7Z0JBQ3hCLFdBQVcsR0FBRyxLQUFLLENBQUM7WUFDdEIsQ0FBQztRQUNILENBQUM7UUFFRCxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDWixNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLEVBQ2xDLHdEQUF3RCxJQUFBLHVCQUFlLEVBQUMsV0FBVyxDQUFDLEVBQUUsQ0FDdkYsQ0FBQztRQUNKLENBQUM7UUFFRCxJQUFJLENBQUMseUJBQXlCLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxFQUFFLENBQUM7WUFDN0MsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLGdCQUFnQixFQUNsQyxtRUFBbUUsQ0FDcEUsQ0FBQztRQUNKLENBQUM7UUFDRCxPQUFPLHNCQUFzQixDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3hDLENBQUM7SUFFRCxLQUFLLENBQUMsYUFBYSxDQUFDLEtBQXlCO1FBQzNDLE1BQU0sSUFBSSxHQUFHLFdBQVcsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDckMsTUFBTSxNQUFNLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUN6QyxNQUFNLFFBQVEsR0FBRyxJQUFBLHNCQUFjLEVBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFDeEQsSUFBSSxNQUFNLEtBQUssU0FBUyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDdEMsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsa0RBQWtELENBQ25ELENBQUM7UUFDSixDQUFDO1FBRUQsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLG9CQUFvQixDQUFDLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO1FBQ3hFLE1BQU0sTUFBTSxHQUFHLE1BQU0sSUFBSSxDQUFDLGtCQUFrQixDQUFDLElBQUksRUFBRSxNQUFNLENBQUMsQ0FBQztRQUMzRCxNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsUUFBUSxDQUFDO1FBQ25DLE1BQU0sV0FBVyxHQUFHLElBQUEsb0JBQVksRUFBQyxNQUFNLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFDbkQsSUFBSSxDQUFDO1lBQ0gsTUFBTSxNQUFNLENBQUMsZ0JBQWdCLENBQUMsVUFBVSxFQUFFO2dCQUN4QyxXQUFXO2dCQUNYLFdBQVcsRUFBRSxxQkFBcUIsSUFBQSxzQkFBYyxFQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxVQUFVLEVBQUU7YUFDbEYsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztRQUFDLE9BQU8sS0FBYyxFQUFFLENBQUM7WUFDeEIsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLGdCQUFnQixFQUNsQyw0Q0FBNEMsTUFBTSxDQUFDLEVBQUUsSUFBSSxVQUFVLEtBQUssSUFBQSx1QkFBZSxFQUFDLEtBQUssQ0FBQyxFQUFFLENBQ2pHLENBQUM7UUFDSixDQUFDO1FBQ0QsT0FBTztZQUNMLElBQUksRUFBRTtnQkFDSixHQUFHLElBQUk7Z0JBQ1AsR0FBRyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7Z0JBQ3RELGtCQUFrQixFQUFFLFVBQVU7Z0JBQzlCLHFCQUFxQixFQUFFLE1BQU0sQ0FBQyxVQUFVO2dCQUN4QyxHQUFHLENBQUMsTUFBTSxDQUFDLFNBQVM7b0JBQ2xCLENBQUMsQ0FBQyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sQ0FBQyxTQUFTLEVBQUU7b0JBQzNDLENBQUMsQ0FBQyxFQUFFLENBQUM7Z0JBQ1AsZUFBZSxFQUFFLGtCQUFrQjtnQkFDbkMsMkJBQTJCLEVBQUUsTUFBTTthQUNwQztTQUNGLENBQUM7SUFDSixDQUFDO0lBRUQsS0FBSyxDQUFDLGVBQWUsQ0FDbkIsS0FBMkI7UUFFM0IsTUFBTSxJQUFJLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNyQyxNQUFNLFVBQVUsR0FBRyxJQUFBLHNCQUFjLEVBQUMsSUFBSSxDQUFDLGtCQUFrQixDQUFDLENBQUM7UUFDM0QsSUFBSSxDQUFDLFVBQVU7WUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUM7UUFFakMsTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUMsb0JBQW9CLENBQzVDLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLENBQUMsQ0FDOUIsQ0FBQywyQkFBMkIsQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUMxQyxPQUFPO1lBQ0wsSUFBSSxFQUFFO2dCQUNKLEdBQUcsSUFBSTtnQkFDUCxHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxzQkFBc0IsRUFBRSxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQzthQUNwRTtTQUNGLENBQUM7SUFDSixDQUFDO0lBRUQsS0FBSyxDQUFDLGFBQWEsQ0FBQyxLQUF5QjtRQUMzQyxNQUFNLElBQUksR0FBRyxXQUFXLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3JDLE1BQU0sY0FBYyxHQUFHLFdBQVcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUM7UUFDekQsTUFBTSxVQUFVLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUM3QyxNQUFNLGdCQUFnQixHQUFHLElBQUEsc0JBQWMsRUFBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsQ0FBQztRQUNoRSxNQUFNLFlBQVksR0FBRyxrQkFBa0IsQ0FBQyxLQUFLLENBQUMsYUFBYSxJQUFJLEVBQUUsQ0FBQyxDQUFDO1FBQ25FLE1BQU0sYUFBYSxHQUNqQixjQUFjLEtBQUssU0FBUztZQUM1QixVQUFVLEtBQUssU0FBUztZQUN4QixJQUFJLENBQUMsR0FBRyxDQUFDLGNBQWMsR0FBRyxVQUFVLENBQUMsSUFBSSxTQUFTLENBQUM7UUFDckQsTUFBTSxlQUFlLEdBQ25CLGdCQUFnQixLQUFLLFNBQVM7WUFDOUIsWUFBWSxLQUFLLEVBQUU7WUFDbkIsZ0JBQWdCLEtBQUssWUFBWSxDQUFDO1FBRXBDLE9BQU87WUFDTCxJQUFJLEVBQUU7Z0JBQ0osR0FBRyxJQUFJO2dCQUNQLEdBQUcsQ0FBQyxhQUFhLElBQUksZUFBZTtvQkFDbEMsQ0FBQyxDQUFDLEVBQUUsc0JBQXNCLEVBQUUsSUFBSSxFQUFFO29CQUNsQyxDQUFDLENBQUMsRUFBRSxDQUFDO2FBQ1I7U0FDRixDQUFDO0lBQ0osQ0FBQztJQUVELEtBQUssQ0FBQyxnQkFBZ0IsQ0FDcEIsS0FBNEI7UUFFNUIsTUFBTSxJQUFJLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNyQyxNQUFNLE1BQU0sR0FBRyxJQUFBLHNCQUFjLEVBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxFQUFFLFdBQVcsRUFBRSxDQUFDO1FBQ25FLE1BQU0sTUFBTSxHQUNWLE1BQU0sS0FBSyxNQUFNO1lBQ2YsQ0FBQyxDQUFDLFVBQVU7WUFDWixDQUFDLENBQUM7Z0JBQ0ksV0FBVztnQkFDWCxVQUFVO2dCQUNWLFNBQVM7Z0JBQ1QsVUFBVTtnQkFDVixZQUFZO2FBQ2IsQ0FBQyxRQUFRLENBQUMsTUFBTSxJQUFJLEVBQUUsQ0FBQztnQkFDMUIsQ0FBQyxDQUFDLFVBQVU7Z0JBQ1osQ0FBQyxDQUFDLFNBQVMsQ0FBQztRQUNsQixPQUFPLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsQ0FBQztJQUNsQyxDQUFDO0lBRU8sS0FBSyxDQUFDLGNBQWMsQ0FDMUIsUUFBNEIsRUFDNUIsaUJBQXFDLEVBQ3JDLE9BQTJCO1FBRTNCLElBQUksaUJBQWlCLEVBQUUsVUFBVSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7WUFDN0MsTUFBTSxPQUFPLEdBQUcsTUFBTSxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1lBQzFELElBQUksT0FBTztnQkFBRSxPQUFPLE9BQU8sQ0FBQztRQUM5QixDQUFDO1FBQ0QsSUFBSSxpQkFBaUIsRUFBRSxVQUFVLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUMzQyxNQUFNLE9BQU8sR0FBRyxNQUFNLElBQUksQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUM1QyxpQkFBaUIsRUFDakIsT0FBTyxDQUNSLENBQUM7WUFDRixJQUFJLE9BQU87Z0JBQUUsT0FBTyxPQUFPLENBQUM7UUFDOUIsQ0FBQztRQUNELElBQUksaUJBQWlCLEVBQUUsVUFBVSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDM0MsTUFBTSxPQUFPLEdBQUcsTUFBTSxJQUFJLENBQUMsTUFBTSxDQUFDLGVBQWUsQ0FDL0MsaUJBQWlCLEVBQ2pCLE9BQU8sQ0FDUixDQUFDO1lBQ0YsSUFBSSxPQUFPO2dCQUFFLE9BQU8sT0FBTyxDQUFDO1FBQzlCLENBQUM7UUFDRCxPQUFPLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxjQUFjLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUNoRSxDQUFDO0lBRU8scUJBQXFCLENBQUMsT0FBMkI7UUFDdkQsT0FBTyxJQUFJLENBQUMsa0JBQWtCLENBQUMsT0FBTyxDQUFDLElBQUksSUFBSSxFQUFFLENBQUMsQ0FBQztJQUNyRCxDQUFDO0lBRUQ7Ozs7O09BS0c7SUFDSyxLQUFLLENBQUMsY0FBYyxDQUMxQixPQUErQixFQUMvQixXQUF3QztRQUV4QyxNQUFNLE1BQU0sR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDO1FBQzdCLE1BQU0sZ0JBQWdCLEdBQUcsTUFBTSxDQUFDLGlCQUFpQixJQUFJLE1BQU0sQ0FBQyxTQUFTLENBQUM7UUFDdEUsTUFBTSxNQUFNLEdBQUcsZ0JBQWdCLEVBQUUsVUFBVSxDQUFDLE9BQU8sQ0FBQztZQUNsRCxDQUFDLENBQUMsZ0JBQWdCO1lBQ2xCLENBQUMsQ0FBQyxTQUFTLENBQUM7UUFDZCxNQUFNLFNBQVMsR0FBRyxnQkFBZ0IsRUFBRSxVQUFVLENBQUMsT0FBTyxDQUFDO1lBQ3JELENBQUMsQ0FBQyxnQkFBZ0I7WUFDbEIsQ0FBQyxDQUFDLFNBQVMsQ0FBQztRQUNkLElBQUksT0FBTyxDQUFDLEtBQUssS0FBSyxNQUFNLElBQUksQ0FBQyxDQUFDLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7WUFDeEQsSUFBSSxPQUFPLENBQUMsS0FBSyxLQUFLLE1BQU0sRUFBRSxDQUFDO2dCQUM3QixJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FDaEIsa0ZBQWtGLE1BQU0sQ0FBQyxFQUFFLElBQUksU0FBUyxlQUFlLGdCQUFnQixJQUFJLFNBQVMsNkJBQTZCLENBQ2xMLENBQUM7WUFDSixDQUFDO1lBQ0QsT0FBTyxLQUFLLENBQUM7UUFDZixDQUFDO1FBQ0QsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLElBQUksQ0FBQyxNQUFNLENBQUMsYUFBYSxFQUFFLENBQUM7WUFDeEMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2hCLGlGQUFpRixDQUNsRixDQUFDO1lBQ0YsT0FBTyxLQUFLLENBQUM7UUFDZixDQUFDO1FBRUQsSUFBSSxTQUFTLEdBQXdCLE1BQU0sQ0FBQztRQUM1QyxJQUFJLENBQUM7WUFDSCxNQUFNLE1BQU0sR0FBRyxNQUFNLElBQUksQ0FBQyxvQkFBb0IsQ0FDNUMsV0FBVyxDQUNaLENBQUMsMkJBQTJCLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1lBQ3pDLElBQUksQ0FBQyxNQUFNLENBQUMsRUFBRSxJQUFJLE1BQU0sQ0FBQyxFQUFFLEtBQUssTUFBTSxDQUFDLEVBQUUsRUFBRSxDQUFDO2dCQUMxQyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FDaEIsNEVBQTRFLE1BQU0sQ0FBQyxFQUFFLEVBQUUsQ0FDeEYsQ0FBQztnQkFDRixPQUFPLEtBQUssQ0FBQztZQUNmLENBQUM7WUFDRCxJQUFJLENBQUMsQ0FBQyxXQUFXLEVBQUUsTUFBTSxDQUFDLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxNQUFNLElBQUksRUFBRSxDQUFDLEVBQUUsQ0FBQztnQkFDekQsTUFBTSxJQUFJLDZCQUE2QixDQUNyQywrQ0FBK0MsTUFBTSxDQUFDLEVBQUUsWUFBWSxNQUFNLENBQUMsTUFBTSxJQUFJLFNBQVMsR0FBRyxDQUNsRyxDQUFDO1lBQ0osQ0FBQztZQUNELFNBQVMsR0FBRyxNQUFNLENBQUM7UUFDckIsQ0FBQztRQUFDLE9BQU8sS0FBYyxFQUFFLENBQUM7WUFDeEIsSUFBSSxLQUFLLFlBQVksNkJBQTZCO2dCQUFFLE1BQU0sS0FBSyxDQUFDO1lBQ2hFLE1BQU0sT0FBTyxHQUFHLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUN2RSxNQUFNLElBQUksNkJBQTZCLENBQ3JDLDRDQUE0QyxNQUFNLENBQUMsRUFBRSxLQUFLLE9BQU8sRUFBRSxDQUNwRSxDQUFDO1FBQ0osQ0FBQztRQUVELElBQ0UsU0FBUyxDQUFDLGFBQWE7WUFDdkIsU0FBUyxDQUFDLGFBQWEsS0FBSyxNQUFNLENBQUMsYUFBYSxFQUNoRCxDQUFDO1lBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2hCLDhDQUE4QyxNQUFNLENBQUMsRUFBRSxFQUFFLENBQzFELENBQUM7WUFDRixPQUFPLEtBQUssQ0FBQztRQUNmLENBQUM7UUFDRCxJQUNFLFNBQVMsQ0FBQyxpQkFBaUI7WUFDM0IsU0FBUyxDQUFDLGlCQUFpQixLQUFLLGdCQUFnQixFQUNoRCxDQUFDO1lBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2hCLHFEQUFxRCxNQUFNLENBQUMsRUFBRSxFQUFFLENBQ2pFLENBQUM7WUFDRixPQUFPLEtBQUssQ0FBQztRQUNmLENBQUM7UUFFRCxNQUFNLFFBQVEsR0FBRyxTQUFTLENBQUMsUUFBUSxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUM7UUFDdkQsSUFBSSxDQUFDLFFBQVEsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLElBQUksUUFBUSxLQUFLLE1BQU0sQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO1lBQ25FLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUNoQiw2REFBNkQsTUFBTSxDQUFDLEVBQUUsRUFBRSxDQUN6RSxDQUFDO1lBQ0YsT0FBTyxLQUFLLENBQUM7UUFDZixDQUFDO1FBQ0QsTUFBTSxXQUFXLEdBQ2YsU0FBUyxDQUFDLGFBQWE7WUFDdkIsU0FBUyxDQUFDLFdBQVc7WUFDckIsTUFBTSxDQUFDLGFBQWE7WUFDcEIsTUFBTSxDQUFDLFdBQVcsQ0FBQztRQUNyQixJQUFJLENBQUMsTUFBTSxDQUFDLGFBQWEsQ0FBQyxXQUFXLENBQUMsSUFBSSxNQUFNLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDbkUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2hCLHNEQUFzRCxNQUFNLENBQUMsRUFBRSxFQUFFLENBQ2xFLENBQUM7WUFDRixPQUFPLEtBQUssQ0FBQztRQUNmLENBQUM7UUFDRCxNQUFNLGFBQWEsR0FBRyxDQUFDLE1BQU0sQ0FBQyxhQUFhLEVBQUUsTUFBTSxDQUFDLFdBQVcsQ0FBQyxDQUFDLE1BQU0sQ0FDckUsQ0FBQyxLQUFLLEVBQW1CLEVBQUUsQ0FBQyxLQUFLLEtBQUssU0FBUyxDQUNoRCxDQUFDO1FBQ0YsSUFDRSxhQUFhLENBQUMsTUFBTSxHQUFHLENBQUM7WUFDeEIsQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxLQUFLLFdBQVcsQ0FBQyxFQUNqRSxDQUFDO1lBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2hCLHlDQUF5QyxNQUFNLENBQUMsRUFBRSxFQUFFLENBQ3JELENBQUM7WUFDRixPQUFPLEtBQUssQ0FBQztRQUNmLENBQUM7UUFFRCxNQUFNLGFBQWEsR0FBRyxTQUFTLENBQUMsS0FBSyxJQUFJLE1BQU0sQ0FBQyxLQUFLLENBQUM7UUFDdEQsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQ25CLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUNoQiwyQkFBMkIsTUFBTSxDQUFDLEVBQUUsa0RBQWtELENBQ3ZGLENBQUM7WUFDRixPQUFPLEtBQUssQ0FBQztRQUNmLENBQUM7UUFDRCxNQUFNLGFBQWEsR0FDakIsU0FBUyxDQUFDLFdBQVc7WUFDckIsU0FBUyxDQUFDLFNBQVM7WUFDbkIsTUFBTSxDQUFDLFdBQVc7WUFDbEIsTUFBTSxDQUFDLFNBQVM7WUFDaEIsSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQztRQUMzQixNQUFNLFFBQVEsR0FBRyxXQUFXLENBQWtCLElBQUksQ0FBQyxVQUFVLEVBQUU7WUFDN0QsZUFBTyxDQUFDLFNBQVM7WUFDakIsaUJBQWlCO1lBQ2pCLGVBQWU7U0FDaEIsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ2QsTUFBTSxJQUFJLDZCQUE2QixDQUNyQyw2Q0FBNkMsTUFBTSxDQUFDLEVBQUUsRUFBRSxDQUN6RCxDQUFDO1FBQ0osQ0FBQztRQUVELElBQUksQ0FBQztZQUNILE1BQU0sUUFBUSxDQUFDLElBQUksQ0FBQztnQkFDbEIsSUFBSSxFQUFFLDhCQUE4QjtnQkFDcEMsSUFBSSxFQUFFO29CQUNKLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztvQkFDN0IsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxTQUFTLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO29CQUNuQyxlQUFlLEVBQUUsTUFBTSxDQUFDLEVBQUU7b0JBQzFCLEdBQUcsQ0FBQyxTQUFTLENBQUMsUUFBUSxJQUFJLE1BQU0sQ0FBQyxRQUFRO3dCQUN2QyxDQUFDLENBQUMsRUFBRSxnQkFBZ0IsRUFBRSxTQUFTLENBQUMsUUFBUSxJQUFJLE1BQU0sQ0FBQyxRQUFRLEVBQUU7d0JBQzdELENBQUMsQ0FBQyxFQUFFLENBQUM7b0JBQ1AsaUJBQWlCLEVBQUUsZ0JBQWdCO29CQUNuQyxXQUFXO29CQUNYLFlBQVksRUFBRSxRQUFRO29CQUN0QixhQUFhO29CQUNiLGFBQWE7b0JBQ2IsYUFBYSxFQUFFLE1BQU0sQ0FBQyxhQUFhO29CQUNuQyxHQUFHLENBQUMsTUFBTSxDQUFDLFNBQVMsRUFBRSxVQUFVLENBQUMsU0FBUyxDQUFDO3dCQUN6QyxDQUFDLENBQUMsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLENBQUMsU0FBUyxFQUFFO3dCQUN4QyxDQUFDLENBQUMsRUFBRSxDQUFDO2lCQUNSO2FBQ0YsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztRQUFDLE9BQU8sS0FBYyxFQUFFLENBQUM7WUFDeEIsTUFBTSxPQUFPLEdBQUcsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ3ZFLE1BQU0sSUFBSSw2QkFBNkIsQ0FDckMsNkNBQTZDLE1BQU0sQ0FBQyxFQUFFLEtBQUssT0FBTyxFQUFFLENBQ3JFLENBQUM7UUFDSixDQUFDO1FBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2YsNkRBQTZELE1BQU0sQ0FBQyxFQUFFLGNBQWMsZ0JBQWdCLEVBQUUsQ0FDdkcsQ0FBQztRQUNGLE9BQU8sSUFBSSxDQUFDO0lBQ2QsQ0FBQztJQUVELEtBQUssQ0FBQyx1QkFBdUIsQ0FDM0IsT0FBMEM7UUFFMUMsTUFBTSxXQUFXLEdBQXdCO1lBQ3ZDLE1BQU0sRUFBRSxzQkFBYyxDQUFDLGFBQWE7WUFDcEMsSUFBSSxFQUFFLEVBQUUsVUFBVSxFQUFFLEVBQUUsRUFBRSxNQUFNLEVBQUUsSUFBSSxpQkFBUyxDQUFDLENBQUMsQ0FBQyxFQUFFO1NBQ25ELENBQUM7UUFFRixJQUFJLENBQUM7WUFDSCxNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUM7Z0JBQzlDLENBQUMsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUM7Z0JBQ2xDLENBQUMsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sSUFBSSxFQUFFLENBQUMsQ0FBQztZQUNsQyxNQUFNLE9BQU8sR0FBRyxJQUFBLG9DQUF3QixFQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUN2RCxJQUFJLE9BQU8sQ0FBQyxJQUFJLEtBQUssYUFBYTtnQkFBRSxPQUFPLFdBQVcsQ0FBQztZQUV2RCxNQUFNLG9CQUFvQixHQUN4QixPQUFPLENBQUMsSUFBSSxLQUFLLFNBQVM7Z0JBQ3hCLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLGFBQWE7Z0JBQzdCLENBQUMsQ0FBQyxPQUFPLENBQUMsYUFBYSxDQUFDO1lBQzVCLE1BQU0sa0JBQWtCLEdBQUcsb0JBQW9CO2dCQUM3QyxDQUFDLENBQUMsSUFBQSxrREFBd0MsRUFDdEMsSUFBSSxDQUFDLFFBQVEsRUFDYixvQkFBb0IsQ0FDckI7Z0JBQ0gsQ0FBQyxDQUFDLFNBQVMsQ0FBQztZQUNkLElBQUksb0JBQW9CLElBQUksQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO2dCQUNoRCxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FDZix3REFBd0QsQ0FDekQsQ0FBQztnQkFDRixPQUFPLFdBQVcsQ0FBQztZQUNyQixDQUFDO1lBRUQsTUFBTSxPQUFPLEdBQUcsTUFBTSxJQUFJLENBQUMsY0FBYyxDQUN2QyxPQUFPLENBQUMsSUFBSSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLFNBQVMsRUFDL0QsT0FBTyxDQUFDLElBQUksS0FBSyxTQUFTO2dCQUN4QixDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLGlCQUFpQixJQUFJLE9BQU8sQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDO2dCQUM5RCxDQUFDLENBQUMsT0FBTyxDQUFDLGlCQUFpQixFQUM3QixPQUFPLENBQUMsSUFBSSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FDMUQsQ0FBQztZQUNGLElBQUksQ0FBQyxPQUFPLElBQUksT0FBTyxDQUFDLFVBQVUsSUFBSSxPQUFPLENBQUMsTUFBTSxLQUFLLFVBQVUsRUFBRSxDQUFDO2dCQUNwRSxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsSUFBSSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDO2dCQUN4RSxNQUFNLE9BQU8sR0FDWCxPQUFPLENBQUMsSUFBSSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztnQkFDNUQsSUFBSSxDQUFDLGtCQUFrQixFQUFFLENBQUM7b0JBQ3hCLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUNoQixjQUFjLEtBQUssMEVBQTBFLE9BQU8sSUFBSSxTQUFTLHdDQUF3QyxDQUMxSixDQUFDO29CQUNGLE9BQU8sV0FBVyxDQUFDO2dCQUNyQixDQUFDO2dCQUVELE1BQU0sSUFBSSxHQUFHLElBQUEsdUNBQTZCLEVBQUM7b0JBQ3pDLE9BQU87b0JBQ1AsT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPLElBQUksRUFBRTtvQkFDOUIsSUFBSSxFQUFFLE9BQU8sQ0FBQyxJQUFJO29CQUNsQixPQUFPLEVBQUU7d0JBQ1AsTUFBTSxFQUFFLGtCQUFrQixDQUFDLGFBQWE7d0JBQ3hDLGdCQUFnQixFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsdUJBQXVCO3dCQUN2RCxXQUFXLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxzQkFBc0I7cUJBQ2xEO2lCQUNGLENBQUMsQ0FBQztnQkFDSCxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxDQUFDO29CQUNiLG9FQUFvRTtvQkFDcEUsbUVBQW1FO29CQUNuRSx1REFBdUQ7b0JBQ3ZELElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNmLG1FQUFtRSxJQUFJLENBQUMsTUFBTSxFQUFFO3dCQUM5RSxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLFVBQVUsS0FBSyxZQUFZLE9BQU8sSUFBSSxTQUFTLEVBQUU7d0JBQ3hGLGtCQUFrQixrQkFBa0IsQ0FBQyxhQUFhLElBQUksU0FBUyxFQUFFLENBQ3BFLENBQUM7b0JBQ0YsT0FBTyxXQUFXLENBQUM7Z0JBQ3JCLENBQUM7Z0JBRUQsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2YsY0FBYyxLQUFLLGlEQUFpRCxPQUFPLElBQUksU0FBUyxHQUFHLENBQzVGLENBQUM7Z0JBQ0YsSUFBSSxPQUFPLENBQUMsSUFBSSxLQUFLLFNBQVMsSUFBSSxPQUFPLENBQUMsS0FBSyxLQUFLLE1BQU0sRUFBRSxDQUFDO29CQUMzRCxNQUFNLElBQUksQ0FBQyxjQUFjLENBQUMsT0FBTyxFQUFFLGtCQUFrQixDQUFDLENBQUM7Z0JBQ3pELENBQUM7Z0JBQ0QsT0FBTyxXQUFXLENBQUM7WUFDckIsQ0FBQztZQUVELE1BQU0sa0JBQWtCLEdBQUcsSUFBSSxDQUFDLHFCQUFxQixDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBRS9ELE1BQU0sSUFBSSxHQUFHLElBQUEsdUNBQTZCLEVBQUM7Z0JBQ3pDLE9BQU87Z0JBQ1AsT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPLElBQUksRUFBRTtnQkFDOUIsSUFBSSxFQUFFLE9BQU8sQ0FBQyxJQUFJO2dCQUNsQixPQUFPLEVBQUU7b0JBQ1AsTUFBTSxFQUNKLGtCQUFrQixFQUFFLGFBQWE7d0JBQ2pDLGtCQUFrQixDQUFDLGFBQWE7b0JBQ2xDLGdCQUFnQixFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsdUJBQXVCO29CQUN2RCxXQUFXLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxzQkFBc0I7aUJBQ2xEO2FBQ0YsQ0FBQyxDQUFDO1lBQ0gsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsQ0FBQztnQkFDYixJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FDZixvRUFBb0UsSUFBSSxDQUFDLE1BQU0sRUFBRTtvQkFDL0UsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxZQUFZLE9BQU8sQ0FBQyxFQUFFLEVBQUU7b0JBQy9ELGtCQUFrQixrQkFBa0IsQ0FBQyxhQUFhLElBQUksU0FBUyxFQUFFLENBQ3BFLENBQUM7Z0JBQ0YsT0FBTyxXQUFXLENBQUM7WUFDckIsQ0FBQztZQUVELElBQ0Usb0JBQW9CO2dCQUNwQixvQkFBb0IsS0FBSyxrQkFBa0IsQ0FBQyxhQUFhLEVBQ3pELENBQUM7Z0JBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2hCLCtDQUErQyxPQUFPLENBQUMsRUFBRSxFQUFFLENBQzVELENBQUM7Z0JBQ0YsT0FBTyxXQUFXLENBQUM7WUFDckIsQ0FBQztZQUVELElBQUksT0FBTyxDQUFDLElBQUksS0FBSyxTQUFTLEVBQUUsQ0FBQztnQkFDL0IsSUFBSSxPQUFPLENBQUMsSUFBSSxLQUFLLFlBQVksRUFBRSxDQUFDO29CQUNsQyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FDZixnREFBZ0QsT0FBTyxDQUFDLGlCQUFpQixJQUFJLFNBQVMsRUFBRSxDQUN6RixDQUFDO2dCQUNKLENBQUM7Z0JBQ0QsT0FBTyxXQUFXLENBQUM7WUFDckIsQ0FBQztZQUVELE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDO1lBQ3ZDLElBQUksQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVcsSUFBSSxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQztnQkFDNUQsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2hCLDRDQUE0QyxPQUFPLENBQUMsRUFBRSxFQUFFLENBQ3pELENBQUM7Z0JBQ0YsT0FBTyxXQUFXLENBQUM7WUFDckIsQ0FBQztZQUVELE1BQU0sY0FBYyxHQUFHLElBQUEsc0JBQWMsRUFBQyxXQUFXLENBQUMsa0JBQWtCLENBQUMsQ0FBQztZQUN0RSxJQUFJLE9BQU8sQ0FBQyxLQUFLLENBQUMsUUFBUSxJQUFJLGNBQWMsS0FBSyxPQUFPLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxDQUFDO2dCQUN4RSxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FDaEIsNENBQTRDLE9BQU8sQ0FBQyxFQUFFLEVBQUUsQ0FDekQsQ0FBQztnQkFDRixPQUFPLFdBQVcsQ0FBQztZQUNyQixDQUFDO1lBRUQsTUFBTSxnQkFBZ0IsR0FDcEIsT0FBTyxDQUFDLEtBQUssQ0FBQyxpQkFBaUIsSUFBSSxPQUFPLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQztZQUM3RCxNQUFNLHVCQUF1QixHQUMzQixJQUFBLHNCQUFjLEVBQUMsV0FBVyxDQUFDLDJCQUEyQixDQUFDLElBQUksT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUN4RSxNQUFNLGdCQUFnQixHQUNwQixnQkFBZ0IsS0FBSyxPQUFPLENBQUMsRUFBRTtnQkFDL0IsZ0JBQWdCLEtBQUssdUJBQXVCLENBQUM7WUFDL0MsSUFDRSxDQUFDLGdCQUFnQixJQUFJLENBQUMsZ0JBQWdCLENBQUM7Z0JBQ3ZDLENBQUMsT0FBTyxDQUFDLEtBQUssS0FBSyxNQUFNLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxFQUMvQyxDQUFDO2dCQUNELElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUNoQixzREFBc0QsT0FBTyxDQUFDLEVBQUUsRUFBRSxDQUNuRSxDQUFDO2dCQUNGLE9BQU8sV0FBVyxDQUFDO1lBQ3JCLENBQUM7WUFFRCxNQUFNLGFBQWEsR0FBRyxJQUFBLHNCQUFjLEVBQUMsV0FBVyxDQUFDLGlCQUFpQixDQUFDLENBQUM7WUFDcEUsSUFDRSxDQUFDLGFBQWEsSUFBSSxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsS0FBSyxhQUFhLENBQUM7Z0JBQ3JELENBQUMsT0FBTyxDQUFDLEtBQUssS0FBSyxNQUFNLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxFQUMvQyxDQUFDO2dCQUNELElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUNoQixtREFBbUQsT0FBTyxDQUFDLEVBQUUsRUFBRSxDQUNoRSxDQUFDO2dCQUNGLE9BQU8sV0FBVyxDQUFDO1lBQ3JCLENBQUM7WUFFRCxNQUFNLGNBQWMsR0FBRyxJQUFBLHNCQUFjLEVBQ25DLFdBQVcsQ0FBQyxpQkFBaUIsQ0FDOUIsRUFBRSxXQUFXLEVBQUUsQ0FBQztZQUNqQixJQUNFLE9BQU8sQ0FBQyxLQUFLLENBQUMsUUFBUTtnQkFDdEIsY0FBYztnQkFDZCxPQUFPLENBQUMsS0FBSyxDQUFDLFFBQVEsS0FBSyxjQUFjLEVBQ3pDLENBQUM7Z0JBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2hCLDRDQUE0QyxPQUFPLENBQUMsRUFBRSxFQUFFLENBQ3pELENBQUM7Z0JBQ0YsT0FBTyxXQUFXLENBQUM7WUFDckIsQ0FBQztZQUNELElBQUksT0FBTyxDQUFDLEtBQUssS0FBSyxNQUFNLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxDQUFDO2dCQUN4RCxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FDaEIsdURBQXVELE9BQU8sQ0FBQyxFQUFFLEVBQUUsQ0FDcEUsQ0FBQztnQkFDRixPQUFPLFdBQVcsQ0FBQztZQUNyQixDQUFDO1lBRUQsTUFBTSxhQUFhLEdBQUcsV0FBVyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUNsRCxNQUFNLGFBQWEsR0FDakIsYUFBYSxLQUFLLFNBQVMsSUFBSSxjQUFjO2dCQUMzQyxDQUFDLENBQUMsSUFBQSxvQkFBWSxFQUFDLGFBQWEsRUFBRSxjQUFjLENBQUM7Z0JBQzdDLENBQUMsQ0FBQyxTQUFTLENBQUM7WUFDaEIsTUFBTSxhQUFhLEdBQUc7Z0JBQ3BCLE9BQU8sQ0FBQyxLQUFLLENBQUMsV0FBVztnQkFDekIsT0FBTyxDQUFDLEtBQUssQ0FBQyxhQUFhO2FBQzVCLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxFQUFtQixFQUFFLENBQUMsS0FBSyxLQUFLLFNBQVMsQ0FBQyxDQUFDO1lBQzFELElBQ0UsYUFBYSxLQUFLLFNBQVM7Z0JBQzNCLGFBQWEsQ0FBQyxNQUFNLEdBQUcsQ0FBQztnQkFDeEIsQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxLQUFLLGFBQWEsQ0FBQyxFQUNuRSxDQUFDO2dCQUNELElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUNoQiwwQ0FBMEMsT0FBTyxDQUFDLEVBQUUsRUFBRSxDQUN2RCxDQUFDO2dCQUNGLE9BQU8sV0FBVyxDQUFDO1lBQ3JCLENBQUM7WUFDRCxJQUNFLE9BQU8sQ0FBQyxLQUFLLEtBQUssTUFBTTtnQkFDeEIsQ0FBQyxhQUFhLEtBQUssU0FBUyxJQUFJLGFBQWEsQ0FBQyxNQUFNLEtBQUssQ0FBQyxDQUFDLEVBQzNELENBQUM7Z0JBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2hCLGdFQUFnRSxPQUFPLENBQUMsRUFBRSxFQUFFLENBQzdFLENBQUM7Z0JBQ0YsT0FBTyxXQUFXLENBQUM7WUFDckIsQ0FBQztZQUVELE1BQU0sSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsT0FBTyxFQUFFO2dCQUMvQixlQUFlLEVBQUUsT0FBTyxDQUFDLEtBQUs7Z0JBQzlCLEdBQUcsQ0FBQyxDQUFDLGFBQWEsSUFBSSxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUU7b0JBQ3BDLENBQUMsQ0FBQyxFQUFFLGlCQUFpQixFQUFFLE9BQU8sQ0FBQyxLQUFLLENBQUMsRUFBRSxFQUFFO29CQUN6QyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUNQLEdBQUcsQ0FBQyxPQUFPLENBQUMsS0FBSyxLQUFLLE1BQU07b0JBQzFCLENBQUMsQ0FBQyxFQUFFLG9CQUFvQixFQUFFLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLEVBQUU7b0JBQ3BELENBQUMsQ0FBQyxFQUFFLENBQUM7YUFDUixDQUFDLENBQUM7WUFFSCxJQUFJLE9BQU8sQ0FBQyxLQUFLLEtBQUssTUFBTSxFQUFFLENBQUM7Z0JBQzdCLElBQUksYUFBYSxLQUFLLFNBQVM7b0JBQUUsT0FBTyxXQUFXLENBQUM7Z0JBQ3BELElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsRUFBRSxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQztnQkFDbkQsT0FBTztvQkFDTCxNQUFNLEVBQUUsc0JBQWMsQ0FBQyxVQUFVO29CQUNqQyxJQUFJLEVBQUU7d0JBQ0osVUFBVSxFQUFFLE9BQU8sQ0FBQyxFQUFFO3dCQUN0QixNQUFNLEVBQUUsSUFBSSxpQkFBUyxDQUFDLGFBQWEsQ0FBQztxQkFDckM7aUJBQ0YsQ0FBQztZQUNKLENBQUM7WUFFRCxJQUFJLE9BQU8sQ0FBQyxLQUFLLEtBQUssV0FBVyxJQUFJLE9BQU8sQ0FBQyxLQUFLLEtBQUssU0FBUyxFQUFFLENBQUM7Z0JBQ2pFLE9BQU87b0JBQ0wsTUFBTSxFQUFFLHNCQUFjLENBQUMsTUFBTTtvQkFDN0IsSUFBSSxFQUFFLEVBQUUsVUFBVSxFQUFFLE9BQU8sQ0FBQyxFQUFFLEVBQUUsTUFBTSxFQUFFLElBQUksaUJBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRTtpQkFDM0QsQ0FBQztZQUNKLENBQUM7WUFFRCxJQUFJLE9BQU8sQ0FBQyxLQUFLLEtBQUssWUFBWSxFQUFFLENBQUM7Z0JBQ25DLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUNoQiw4Q0FBOEMsT0FBTyxDQUFDLEVBQUUsRUFBRSxDQUMzRCxDQUFDO1lBQ0osQ0FBQztZQUNELE9BQU8sV0FBVyxDQUFDO1FBQ3JCLENBQUM7UUFBQyxPQUFPLEtBQWMsRUFBRSxDQUFDO1lBQ3hCLE1BQU0sT0FBTyxHQUFHLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUN2RSxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyx5Q0FBeUMsT0FBTyxFQUFFLENBQUMsQ0FBQztZQUN2RSxJQUFJLEtBQUssWUFBWSw2QkFBNkI7Z0JBQUUsTUFBTSxLQUFLLENBQUM7WUFDaEUsT0FBTyxXQUFXLENBQUM7UUFDckIsQ0FBQztJQUNILENBQUM7O0FBajNCTSx5Q0FBVSxHQUFHLFVBQVUsQUFBYixDQUFjO0FBbzNCakMsa0JBQWUsOEJBQThCLENBQUMifQ==