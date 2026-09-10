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
        const payload = {
            integrationId,
            currency,
            amount,
            email,
            description,
            reference: uniqueReference,
            merchantReference: durableReference,
            serviceFeePayer,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvbmlmdGlwYXkvc2VydmljZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLHFEQU1tQztBQTBCbkMsNkRBQWtFO0FBQ2xFLDJEQUErRDtBQUMvRCxtRUFBK0U7QUFPL0UsMkRBS3lDO0FBQ3pDLCtEQUFrRjtBQUNsRix1Q0FRbUI7QUFDbkIsbURBQWdGO0FBMkJoRixNQUFNLFdBQVcsR0FBRyxDQUFDLEtBQWMsRUFBMkIsRUFBRSxDQUM5RCxJQUFBLGdCQUFRLEVBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0FBRS9CLE1BQU0sV0FBVyxHQUFHLENBQUMsS0FBYyxFQUFzQixFQUFFLENBQ3pELElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsQ0FBQztBQUV4QixNQUFNLHNCQUFzQixHQUFHLENBQUMsS0FBYyxFQUFzQixFQUFFLENBQ3BFLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsRUFBRSxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFFNUQsTUFBTSxjQUFjLEdBQUcsQ0FDckIsUUFBZ0IsRUFDaEIsTUFLRSxFQUNNLEVBQUUsQ0FDVixRQUFRO0tBQ0wsVUFBVSxDQUFDLFdBQVcsRUFBRSxNQUFNLENBQUMsTUFBTSxDQUFDO0tBQ3RDLFVBQVUsQ0FBQyxjQUFjLEVBQUUsTUFBTSxDQUFDLFNBQVMsQ0FBQztLQUM1QyxVQUFVLENBQUMsY0FBYyxFQUFFLE1BQU0sQ0FBQyxTQUFTLElBQUksRUFBRSxDQUFDO0tBQ2xELFVBQVUsQ0FBQyxpQkFBaUIsRUFBRSxNQUFNLENBQUMsWUFBWSxJQUFJLEVBQUUsQ0FBQztLQUN4RCxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQztLQUNw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