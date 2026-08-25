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
            // Medusa intentionally hard-deletes payment sessions whenever a cart's
            // total changes. The cart ID survives that lifecycle and lets a verified
            // late-paid webhook recover the exact checkout.
            merchantReference: cartId,
            serviceFeePayer,
            ...(returnUrl ? { returnUrl } : {}),
            ...(failureUrl ? { failureUrl } : {}),
        };
        try {
            const created = await this.clientForCredentials(credentials).createFiatOrder(payload);
            if (created.reference &&
                created.reference !== sessionId &&
                created.reference !== cartId) {
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
                niftipay_merchant_reference: cartId,
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
        return orderKey ? this.store_.findByOrderKey(orderKey) : null;
    }
    credentialsForSession(session) {
        return this.credentialsForData(session.data ?? {});
    }
    /**
     * Emits an app-owned recovery event only after the webhook has passed the
     * integration-bound HMAC check. The remote status lookup is a second check;
     * signed webhook data remains the fallback during a temporary API outage.
     */
    async emitOrphanPaid(webhook, credentials) {
        const signed = webhook.order;
        const cartId = signed.merchantReference;
        if (webhook.event !== "paid" || !cartId?.startsWith("cart_")) {
            if (webhook.event === "paid") {
                this.logger_.error(`[niftipay] authenticated orphan paid webhook has no durable cart reference (orderId=${signed.id ?? "unknown"}, reference=${cartId ?? "unknown"}); manual recovery required`);
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
                this.logger_.error(`[niftipay] orphan status lookup is not completed for ${signed.id} (status=${remote.status ?? "unknown"})`);
                return false;
            }
            canonical = remote;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger_.warn(`[niftipay] orphan status lookup failed for ${signed.id}; using authenticated webhook fields: ${message}`);
        }
        if (canonical.integrationId &&
            canonical.integrationId !== signed.integrationId) {
            this.logger_.error(`[niftipay] orphan integration mismatch for ${signed.id}`);
            return false;
        }
        if (canonical.merchantReference &&
            canonical.merchantReference !== cartId) {
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
            this.logger_.error(`[niftipay] event bus unavailable; cannot recover orphan ${signed.id}`);
            return false;
        }
        await eventBus.emit({
            name: "payment.niftipay_orphan_paid",
            data: {
                cartId,
                niftipayOrderId: signed.id,
                ...(canonical.orderKey ?? signed.orderKey
                    ? { niftipayOrderKey: canonical.orderKey ?? signed.orderKey }
                    : {}),
                merchantReference: cartId,
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
        this.logger_.warn(`[niftipay] emitted payment.niftipay_orphan_paid for order ${signed.id} cart=${cartId}`);
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
                const authenticated = (0, webhook_1.verifyNiftipayWebhook)({
                    rawBody,
                    headers: payload.headers ?? {},
                    data: payload.data,
                    options: {
                        secret: webhookCredentials.webhookSecret,
                        toleranceSeconds: this.options_.webhookToleranceSeconds,
                        allowLegacy: this.options_.allowLegacyWebhookAuth,
                    },
                });
                if (!authenticated) {
                    this.logger_.warn("[niftipay] rejected webhook authentication");
                    return unsupported;
                }
                this.logger_.warn(`[niftipay] ${event} webhook has no live payment session (orderId=${orderId ?? "unknown"})`);
                if (webhook.kind === "payment" && webhook.event === "paid") {
                    await this.emitOrphanPaid(webhook, webhookCredentials);
                }
                return unsupported;
            }
            const sessionCredentials = this.credentialsForSession(session);
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
            return unsupported;
        }
    }
}
NiftipayPaymentProviderService.identifier = "niftipay";
exports.default = NiftipayPaymentProviderService;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvbmlmdGlwYXkvc2VydmljZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLHFEQU1tQztBQTBCbkMsNkRBQWtFO0FBQ2xFLDJEQUErRDtBQUMvRCxtRUFBK0U7QUFPL0UsMkRBS3lDO0FBQ3pDLCtEQUEwRTtBQUMxRSx1Q0FRbUI7QUFDbkIsbURBQWdGO0FBMEJoRixNQUFNLFdBQVcsR0FBRyxDQUFDLEtBQWMsRUFBMkIsRUFBRSxDQUM5RCxJQUFBLGdCQUFRLEVBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0FBRS9CLE1BQU0sV0FBVyxHQUFHLENBQUMsS0FBYyxFQUFzQixFQUFFLENBQ3pELElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsQ0FBQztBQUV4QixNQUFNLHNCQUFzQixHQUFHLENBQUMsS0FBYyxFQUFzQixFQUFFLENBQ3BFLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsRUFBRSxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFFNUQsTUFBTSxjQUFjLEdBQUcsQ0FDckIsUUFBZ0IsRUFDaEIsTUFLRSxFQUNNLEVBQUUsQ0FDVixRQUFRO0tBQ0wsVUFBVSxDQUFDLFdBQVcsRUFBRSxNQUFNLENBQUMsTUFBTSxDQUFDO0tBQ3RDLFVBQVUsQ0FBQyxjQUFjLEVBQUUsTUFBTSxDQUFDLFNBQVMsQ0FBQztLQUM1QyxVQUFVLENBQUMsY0FBYyxFQUFFLE1BQU0sQ0FBQyxTQUFTLElBQUksRUFBRSxDQUFDO0tBQ2xELFVBQVUsQ0FBQyxpQkFBaUIsRUFBRSxNQUFNLENBQUMsWUFBWSxJQUFJLEVBQUUsQ0FBQztLQUN4RCxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQztLQUNw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