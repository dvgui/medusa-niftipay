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
        // Send the durable attempt in BOTH fields. Production data has shown that
        // Niftipay can echo `reference` as merchantReference, even when a different
        // merchantReference was submitted. One durable value removes ambiguity.
        const durableReference = attemptId ?? cartId;
        const payload = {
            integrationId,
            currency,
            amount,
            email,
            description,
            reference: durableReference,
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
                niftipay_reference: durableReference,
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