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
    const storedMerchantReference = (0, utils_2.optionalString)(data.niftipay_merchant_reference);
    return !((storedOrderId && remote.id !== storedOrderId) ||
        (storedIntegrationId &&
            remote.integrationId !== storedIntegrationId) ||
        (storedCurrency && remote.currency !== storedCurrency) ||
        (storedMerchantReference &&
            remote.merchantReference !== storedMerchantReference));
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