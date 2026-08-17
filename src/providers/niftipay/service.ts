import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
  Modules,
  PaymentActions,
} from "@medusajs/framework/utils";
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  PaymentSessionStatus,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types";

import { NiftipayClient } from "../../lib/niftipay-client/client";
import { toMinorUnits } from "../../lib/niftipay-client/money";
import { normalizeNiftipayWebhook } from "../../lib/niftipay-client/normalize";
import type {
  NiftipayFiatOrderPayload,
  NiftipayRemoteOrder,
  NiftipayServiceFeePayer,
  NormalizedNiftipayWebhook,
} from "../../lib/niftipay-client/types";
import {
  isRecord,
  optionalNumber,
  optionalString,
} from "../../lib/niftipay-client/utils";
import { verifyNiftipayWebhook } from "../../lib/niftipay-client/webhook";
import {
  type NiftipayProviderOptions,
  type ResolvedNiftipayOptions,
  resolveNiftipayCredentialsForBrand,
  resolveNiftipayCredentialsForIntegration,
  validateNiftipayOptions,
  withDefaults,
} from "./options";
import { NiftipaySessionStore, type NiftipaySessionRow } from "./session-store";

type InjectedDependencies = { logger: Logger; [key: string]: unknown };

type NiftipaySessionData = Readonly<{
  session_id: string;
  cart_id: string;
  brand_slug?: string;
  niftipay_order_id: string;
  niftipay_order_key: string;
  niftipay_redirect_url: string;
  niftipay_reference: string;
  niftipay_merchant_reference: string;
  niftipay_description: string;
  niftipay_integration_id: string;
  niftipay_status: string;
  niftipay_amount: number;
  niftipay_currency: string;
  niftipay_email: string;
  niftipay_customer_name?: string;
  niftipay_return_url?: string;
  niftipay_failure_url?: string;
  niftipay_service_fee_payer: NiftipayServiceFeePayer;
  niftipay_verified_at?: string;
}>;

const paymentData = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const numberValue = (value: unknown): number | undefined =>
  optionalNumber(value);

const normalizedCustomerName = (value: unknown): string | undefined =>
  optionalString(value)?.replace(/\s+/g, " ").slice(0, 120);

const renderTemplate = (
  template: string,
  values: Readonly<{
    cartId: string;
    sessionId: string;
    brandSlug?: string;
    customerName?: string;
  }>,
): string =>
  template
    .replaceAll("{cart_id}", values.cartId)
    .replaceAll("{session_id}", values.sessionId)
    .replaceAll("{brand_slug}", values.brandSlug ?? "")
    .replaceAll("{customer_name}", values.customerName ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);

const substituteUrl = (
  template: string | undefined,
  values: Readonly<{ cartId: string; sessionId: string }>,
): string | undefined => {
  if (!template) return undefined;
  const replaced = template
    .replaceAll("{cart_id}", values.cartId)
    .replaceAll("{session_id}", values.sessionId);
  const parsed = new URL(replaced);
  if (parsed.protocol !== "https:") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Niftipay return and failure URLs must use HTTPS",
    );
  }
  return parsed.toString();
};

const normalizedCurrency = (value: string): string => value.toUpperCase();

const safeResolve = <T>(
  container: Record<string, unknown>,
  keys: readonly string[],
): T | undefined => {
  for (const key of keys) {
    try {
      const value = container[key];
      if (value != null) return value as T;
    } catch {
      // Awilix cradle proxies throw for registrations absent from this scope.
    }
  }
  return undefined;
};

type NiftipayPaymentWebhook = Extract<
  NormalizedNiftipayWebhook,
  { kind: "payment" }
>;

type EventBusService = {
  emit(input: {
    name: string;
    data: Record<string, unknown>;
  }): Promise<unknown>;
};

class NiftipayPaymentProviderService extends AbstractPaymentProvider<NiftipayProviderOptions> {
  static identifier = "niftipay";

  protected logger_: Logger;
  protected options_: ResolvedNiftipayOptions;
  private readonly client_: NiftipayClient;
  private readonly store_: NiftipaySessionStore;
  private readonly container_: InjectedDependencies;
  private readonly verifiedSessions_ = new Map<string, number>();

  static validateOptions(options: Record<string, unknown>): void {
    validateNiftipayOptions(options);
  }

  constructor(
    container: InjectedDependencies,
    options: NiftipayProviderOptions,
  ) {
    super(container, options);
    this.logger_ = container.logger;
    this.container_ = container;
    this.options_ = withDefaults(options);
    this.client_ = new NiftipayClient({
      apiKey: options.apiKey,
      baseUrl: this.options_.baseUrl,
      allowedRedirectHosts: options.allowedRedirectHosts,
    });
    this.store_ = new NiftipaySessionStore(container, container.logger);
  }

  private isRecentlyVerified(sessionId: string): boolean {
    const verifiedAt = this.verifiedSessions_.get(sessionId);
    if (!verifiedAt) return false;
    if (Date.now() - verifiedAt > this.options_.verifiedTtlMs) {
      this.verifiedSessions_.delete(sessionId);
      return false;
    }
    return true;
  }

  async initiatePayment(
    input: InitiatePaymentInput,
  ): Promise<InitiatePaymentOutput> {
    const data = paymentData(input.data);
    const sessionId = optionalString(data.session_id) ?? "";
    const cartId = optionalString(data.cart_id) ?? "";
    const amount = numberValue(input.amount);
    const currency = normalizedCurrency(input.currency_code || "gbp");
    const email =
      optionalString(input.context?.customer?.email) ??
      optionalString(data.email);
    const customerContext = paymentData(input.context?.customer);
    const contextCustomerName = normalizedCustomerName(
      [
        optionalString(customerContext.first_name),
        optionalString(customerContext.last_name),
      ]
        .filter((part): part is string => Boolean(part))
        .join(" "),
    );
    const customerName =
      normalizedCustomerName(data.customer_name) ??
      normalizedCustomerName(customerContext.name) ??
      contextCustomerName;

    if (!/^payses_[A-Za-z0-9]+$/.test(sessionId)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Niftipay payment session ID is missing or invalid",
      );
    }
    if (!/^cart_[A-Za-z0-9]+$/.test(cartId)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Niftipay requires a valid cart ID for the hosted return flow",
      );
    }
    if (amount === undefined || amount <= 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Niftipay payment amount must be greater than zero",
      );
    }
    if (!email) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Niftipay requires a customer email address",
      );
    }

    const allowedCurrencies = (this.options_.allowedCurrencies ?? []).map(
      normalizedCurrency,
    );
    if (allowedCurrencies.length > 0 && !allowedCurrencies.includes(currency)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Niftipay does not allow ${currency} payments`,
      );
    }

    // Validate the ISO minor-unit precision before creating the remote order.
    toMinorUnits(amount, currency);

    const serviceFeePayer = this.options_.serviceFeePayer;
    const brandSlug =
      optionalString(data.niftipay_brand_slug) ??
      optionalString(data.brand_slug);
    const brandSettings = brandSlug
      ? this.options_.brandSettings?.[brandSlug]
      : undefined;
    const credentials = resolveNiftipayCredentialsForBrand(
      this.options_,
      brandSlug,
    );
    const integrationId = credentials.integrationId;
    const returnUrl = substituteUrl(
      brandSettings?.returnUrl ?? this.options_.returnUrl,
      { cartId, sessionId },
    );
    const failureUrl = substituteUrl(
      brandSettings?.failureUrl ?? this.options_.failureUrl,
      { cartId, sessionId },
    );
    if (!returnUrl) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Niftipay has no return URL configured for brand ${brandSlug ?? "default"}`,
      );
    }

    const description = renderTemplate(
      brandSettings?.descriptionTemplate ?? this.options_.descriptionTemplate,
      { cartId, sessionId, brandSlug, customerName },
    );
    const payload: NiftipayFiatOrderPayload = {
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
      const created = await this.client_.createFiatOrder(payload);
      if (
        created.reference &&
        created.reference !== sessionId &&
        created.reference !== cartId
      ) {
        throw new Error("Niftipay returned a different merchant reference");
      }
      const sessionData: NiftipaySessionData = {
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to create Niftipay card payment: ${message}`,
      );
    }
  }

  async authorizePayment(
    input: AuthorizePaymentInput,
  ): Promise<AuthorizePaymentOutput> {
    const data = paymentData(input.data);
    const sessionId = optionalString(data.session_id) ?? "";
    const status = optionalString(data.niftipay_status)?.toLowerCase();
    const paid =
      status === "paid" ||
      (sessionId !== "" && this.isRecentlyVerified(sessionId));
    return {
      data,
      status: (paid ? "captured" : "pending") as PaymentSessionStatus,
    };
  }

  async capturePayment(
    input: CapturePaymentInput,
  ): Promise<CapturePaymentOutput> {
    return { data: paymentData(input.data) };
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    // A local cart cancellation must not race a late successful card webhook.
    return { data: paymentData(input.data) };
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    // Switching methods only removes Medusa state; it does not refund/cancel.
    return { data: paymentData(input.data) };
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const data = paymentData(input.data);
    const identifier = optionalString(data.niftipay_order_key);
    const amount = numberValue(input.amount);
    const currency = optionalString(data.niftipay_currency);
    if (!identifier || amount === undefined || !currency) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Niftipay order key, refund amount, and currency are required",
      );
    }

    const amountCents = toMinorUnits(amount, currency);
    await this.client_.createFiatRefund(identifier, {
      amountCents,
      description: `Medusa refund for ${optionalString(data.session_id) ?? identifier}`,
    });
    return {
      data: {
        ...data,
        niftipay_status: "refund_requested",
        niftipay_last_refund_amount: amount,
      },
    };
  }

  async retrievePayment(
    input: RetrievePaymentInput,
  ): Promise<RetrievePaymentOutput> {
    const data = paymentData(input.data);
    const identifier = optionalString(data.niftipay_order_key);
    if (!identifier) return { data };

    const remote = await this.client_.retrieveNormalizedFiatOrder(identifier);
    return {
      data: {
        ...data,
        ...(remote.status ? { niftipay_remote_status: remote.status } : {}),
      },
    };
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const data = paymentData(input.data);
    const previousAmount = numberValue(data.niftipay_amount);
    const nextAmount = numberValue(input.amount);
    const previousCurrency = optionalString(data.niftipay_currency);
    const nextCurrency = normalizedCurrency(input.currency_code || "");
    const amountChanged =
      previousAmount !== undefined &&
      nextAmount !== undefined &&
      Math.abs(previousAmount - nextAmount) >= 0.0000001;
    const currencyChanged =
      previousCurrency !== undefined &&
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

  async getPaymentStatus(
    input: GetPaymentStatusInput,
  ): Promise<GetPaymentStatusOutput> {
    const data = paymentData(input.data);
    const status = optionalString(data.niftipay_status)?.toLowerCase();
    const mapped: PaymentSessionStatus =
      status === "paid"
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

  private async resolveSession(
    orderKey: string | undefined,
    merchantReference: string | undefined,
    orderId: string | undefined,
  ): Promise<NiftipaySessionRow | null> {
    if (merchantReference?.startsWith("payses_")) {
      const session = await this.store_.load(merchantReference);
      if (session) return session;
    }
    if (merchantReference?.startsWith("cart_")) {
      const session = await this.store_.findByCartId(
        merchantReference,
        orderId,
      );
      if (session) return session;
    }
    return orderKey ? this.store_.findByOrderKey(orderKey) : null;
  }

  private credentialsForSession(session: NiftipaySessionRow) {
    const storedIntegrationId = optionalString(
      session.data?.niftipay_integration_id,
    );
    if (storedIntegrationId) {
      const storedCredentials = resolveNiftipayCredentialsForIntegration(
        this.options_,
        storedIntegrationId,
      );
      if (storedCredentials) return storedCredentials;
    }

    const brandSlug = optionalString(session.data?.brand_slug);
    return resolveNiftipayCredentialsForBrand(
      this.options_,
      brandSlug,
    );
  }

  /**
   * Emits an app-owned recovery event only after the webhook has passed the
   * integration-bound HMAC check. The remote status lookup is a second check;
   * signed webhook data remains the fallback during a temporary API outage.
   */
  private async emitOrphanPaid(
    webhook: NiftipayPaymentWebhook,
  ): Promise<boolean> {
    const signed = webhook.order;
    const cartId = signed.merchantReference;
    if (webhook.event !== "paid" || !cartId?.startsWith("cart_")) {
      if (webhook.event === "paid") {
        this.logger_.error(
          `[niftipay] authenticated orphan paid webhook has no durable cart reference (orderId=${signed.id ?? "unknown"}, reference=${cartId ?? "unknown"}); manual recovery required`,
        );
      }
      return false;
    }
    if (!signed.id || !signed.integrationId) {
      this.logger_.error(
        "[niftipay] authenticated orphan paid webhook is missing order or integration ID",
      );
      return false;
    }

    let canonical: NiftipayRemoteOrder = signed;
    try {
      const remote = await this.client_.retrieveNormalizedFiatOrder(signed.id);
      if (!remote.id || remote.id !== signed.id) {
        this.logger_.error(
          `[niftipay] orphan status lookup returned a different public order ID for ${signed.id}`,
        );
        return false;
      }
      if (!["completed", "paid"].includes(remote.status ?? "")) {
        this.logger_.error(
          `[niftipay] orphan status lookup is not completed for ${signed.id} (status=${remote.status ?? "unknown"})`,
        );
        return false;
      }
      canonical = remote;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger_.warn(
        `[niftipay] orphan status lookup failed for ${signed.id}; using authenticated webhook fields: ${message}`,
      );
    }

    if (
      canonical.integrationId &&
      canonical.integrationId !== signed.integrationId
    ) {
      this.logger_.error(
        `[niftipay] orphan integration mismatch for ${signed.id}`,
      );
      return false;
    }
    if (
      canonical.merchantReference &&
      canonical.merchantReference !== cartId
    ) {
      this.logger_.error(
        `[niftipay] orphan merchant reference mismatch for ${signed.id}`,
      );
      return false;
    }

    const currency = canonical.currency ?? signed.currency;
    if (!currency || (signed.currency && currency !== signed.currency)) {
      this.logger_.error(
        `[niftipay] orphan currency is missing or inconsistent for ${signed.id}`,
      );
      return false;
    }
    const amountMinor =
      canonical.subtotalCents ??
      canonical.amountCents ??
      signed.subtotalCents ??
      signed.amountCents;
    if (!Number.isSafeInteger(amountMinor) || Number(amountMinor) <= 0) {
      this.logger_.error(
        `[niftipay] orphan amount is missing or invalid for ${signed.id}`,
      );
      return false;
    }
    const signedAmounts = [signed.subtotalCents, signed.amountCents].filter(
      (value): value is number => value !== undefined,
    );
    if (
      signedAmounts.length > 0 &&
      !signedAmounts.some((value) => Math.round(value) === amountMinor)
    ) {
      this.logger_.error(
        `[niftipay] orphan amount mismatch for ${signed.id}`,
      );
      return false;
    }

    const customerEmail = canonical.email ?? signed.email;
    if (!customerEmail) {
      this.logger_.error(
        `[niftipay] orphan order ${signed.id} has no customer email; manual recovery required`,
      );
      return false;
    }
    const capturedAtIso =
      canonical.completedAt ??
      canonical.updatedAt ??
      signed.completedAt ??
      signed.updatedAt ??
      new Date().toISOString();
    const eventBus = safeResolve<EventBusService>(this.container_, [
      Modules.EVENT_BUS,
      "eventBusService",
      "__event_bus__",
    ]);
    if (!eventBus) {
      this.logger_.error(
        `[niftipay] event bus unavailable; cannot recover orphan ${signed.id}`,
      );
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
    this.logger_.warn(
      `[niftipay] emitted payment.niftipay_orphan_paid for order ${signed.id} cart=${cartId}`,
    );
    return true;
  }

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"],
  ): Promise<WebhookActionResult> {
    const unsupported: WebhookActionResult = {
      action: PaymentActions.NOT_SUPPORTED,
      data: { session_id: "", amount: new BigNumber(0) },
    };

    try {
      const rawBody = Buffer.isBuffer(payload.rawData)
        ? payload.rawData.toString("utf8")
        : String(payload.rawData ?? "");
      const webhook = normalizeNiftipayWebhook(payload.data);
      if (webhook.kind === "unsupported") return unsupported;

      const webhookIntegrationId =
        webhook.kind === "payment"
          ? webhook.order.integrationId
          : webhook.integrationId;
      const webhookCredentials = webhookIntegrationId
        ? resolveNiftipayCredentialsForIntegration(
            this.options_,
            webhookIntegrationId,
          )
        : undefined;
      if (webhookIntegrationId && !webhookCredentials) {
        this.logger_.warn(
          "[niftipay] rejected webhook for an unknown integration",
        );
        return unsupported;
      }

      const session = await this.resolveSession(
        webhook.kind === "payment" ? webhook.order.orderKey : undefined,
        webhook.kind === "payment"
          ? (webhook.order.merchantReference ?? webhook.order.reference)
          : webhook.merchantReference,
        webhook.kind === "payment" ? webhook.order.id : undefined,
      );
      if (!session || session.deleted_at || session.status === "canceled") {
        const event = webhook.kind === "payment" ? webhook.event : "risk_alert";
        const orderId =
          webhook.kind === "payment" ? webhook.order.id : undefined;
        if (!webhookCredentials) {
          this.logger_.error(
            `[niftipay] ${event} webhook has no live session or integration-bound credentials (orderId=${orderId ?? "unknown"}); cannot authenticate orphan recovery`,
          );
          return unsupported;
        }

        const authenticated = verifyNiftipayWebhook({
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

        this.logger_.warn(
          `[niftipay] ${event} webhook has no live payment session (orderId=${orderId ?? "unknown"})`,
        );
        if (webhook.kind === "payment" && webhook.event === "paid") {
          await this.emitOrphanPaid(webhook);
        }
        return unsupported;
      }

      const sessionCredentials = this.credentialsForSession(session);

      const authenticated = verifyNiftipayWebhook({
        rawBody,
        headers: payload.headers ?? {},
        data: payload.data,
        options: {
          secret:
            webhookCredentials?.webhookSecret ??
            sessionCredentials.webhookSecret,
          toleranceSeconds: this.options_.webhookToleranceSeconds,
          allowLegacy: this.options_.allowLegacyWebhookAuth,
        },
      });
      if (!authenticated) {
        this.logger_.warn("[niftipay] rejected webhook authentication");
        return unsupported;
      }

      if (
        webhookIntegrationId &&
        webhookIntegrationId !== sessionCredentials.integrationId
      ) {
        this.logger_.error(
          `[niftipay] integration mismatch for session ${session.id}`,
        );
        return unsupported;
      }

      if (webhook.kind !== "payment") {
        if (webhook.kind === "risk_alert") {
          this.logger_.warn(
            `[niftipay] risk alert received for reference=${webhook.merchantReference ?? "unknown"}`,
          );
        }
        return unsupported;
      }

      const sessionData = session.data ?? {};
      if (!String(session.provider_id ?? "").includes("niftipay")) {
        this.logger_.error(
          `[niftipay] provider mismatch for session ${session.id}`,
        );
        return unsupported;
      }

      const storedOrderKey = optionalString(sessionData.niftipay_order_key);
      if (webhook.order.orderKey && storedOrderKey !== webhook.order.orderKey) {
        this.logger_.error(
          `[niftipay] orderKey mismatch for session ${session.id}`,
        );
        return unsupported;
      }

      const webhookReference =
        webhook.order.merchantReference ?? webhook.order.reference;
      const storedMerchantReference =
        optionalString(sessionData.niftipay_merchant_reference) ?? session.id;
      const referenceMatches =
        webhookReference === session.id ||
        webhookReference === storedMerchantReference;
      if (
        (webhookReference && !referenceMatches) ||
        (webhook.event === "paid" && !referenceMatches)
      ) {
        this.logger_.error(
          `[niftipay] merchant reference mismatch for session ${session.id}`,
        );
        return unsupported;
      }

      const storedOrderId = optionalString(sessionData.niftipay_order_id);
      if (
        (storedOrderId && webhook.order.id !== storedOrderId) ||
        (webhook.event === "paid" && !webhook.order.id)
      ) {
        this.logger_.error(
          `[niftipay] public order ID mismatch for session ${session.id}`,
        );
        return unsupported;
      }

      const storedCurrency = optionalString(
        sessionData.niftipay_currency,
      )?.toUpperCase();
      if (
        webhook.order.currency &&
        storedCurrency &&
        webhook.order.currency !== storedCurrency
      ) {
        this.logger_.error(
          `[niftipay] currency mismatch for session ${session.id}`,
        );
        return unsupported;
      }
      if (webhook.event === "paid" && !webhook.order.currency) {
        this.logger_.error(
          `[niftipay] paid webhook has no currency for session ${session.id}`,
        );
        return unsupported;
      }

      const sessionAmount = numberValue(session.amount);
      const expectedMinor =
        sessionAmount !== undefined && storedCurrency
          ? toMinorUnits(sessionAmount, storedCurrency)
          : undefined;
      const receivedMinor = [
        webhook.order.amountCents,
        webhook.order.subtotalCents,
      ].filter((value): value is number => value !== undefined);
      if (
        expectedMinor !== undefined &&
        receivedMinor.length > 0 &&
        !receivedMinor.some((value) => Math.round(value) === expectedMinor)
      ) {
        this.logger_.error(
          `[niftipay] amount mismatch for session ${session.id}`,
        );
        return unsupported;
      }
      if (
        webhook.event === "paid" &&
        (expectedMinor === undefined || receivedMinor.length === 0)
      ) {
        this.logger_.error(
          `[niftipay] paid webhook has no verifiable amount for session ${session.id}`,
        );
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
        if (sessionAmount === undefined) return unsupported;
        this.verifiedSessions_.set(session.id, Date.now());
        return {
          action: PaymentActions.SUCCESSFUL,
          data: {
            session_id: session.id,
            amount: new BigNumber(sessionAmount),
          },
        };
      }

      if (webhook.event === "cancelled" || webhook.event === "expired") {
        return {
          action: PaymentActions.FAILED,
          data: { session_id: session.id, amount: new BigNumber(0) },
        };
      }

      if (webhook.event === "chargeback") {
        this.logger_.error(
          `[niftipay] chargeback received for session ${session.id}`,
        );
      }
      return unsupported;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger_.error(`[niftipay] webhook processing failed: ${message}`);
      return unsupported;
    }
  }
}

export default NiftipayPaymentProviderService;
