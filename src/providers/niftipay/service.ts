import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
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
  NiftipayServiceFeePayer,
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
  niftipay_description: string;
  niftipay_integration_id: string;
  niftipay_status: string;
  niftipay_amount: number;
  niftipay_currency: string;
  niftipay_email: string;
  niftipay_return_url?: string;
  niftipay_failure_url?: string;
  niftipay_service_fee_payer: NiftipayServiceFeePayer;
  niftipay_verified_at?: string;
}>;

const paymentData = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const numberValue = (value: unknown): number | undefined =>
  optionalNumber(value);

const renderTemplate = (
  template: string,
  values: Readonly<{
    cartId: string;
    sessionId: string;
    brandSlug?: string;
  }>,
): string =>
  template
    .replaceAll("{cart_id}", values.cartId)
    .replaceAll("{session_id}", values.sessionId)
    .replaceAll("{brand_slug}", values.brandSlug ?? "")
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

class NiftipayPaymentProviderService extends AbstractPaymentProvider<NiftipayProviderOptions> {
  static identifier = "niftipay";

  protected logger_: Logger;
  protected options_: ResolvedNiftipayOptions;
  private readonly client_: NiftipayClient;
  private readonly store_: NiftipaySessionStore;
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
    const integrationId =
      brandSettings?.integrationId ?? this.options_.integrationId;
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
      { cartId, sessionId, brandSlug },
    );
    const payload: NiftipayFiatOrderPayload = {
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
      const sessionData: NiftipaySessionData = {
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
  ): Promise<NiftipaySessionRow | null> {
    if (merchantReference?.startsWith("payses_")) {
      const session = await this.store_.load(merchantReference);
      if (session) return session;
    }
    return orderKey ? this.store_.findByOrderKey(orderKey) : null;
  }

  private webhookSecretForSession(session: NiftipaySessionRow): string {
    const brandSlug = optionalString(session.data?.brand_slug);
    return (
      (brandSlug
        ? this.options_.brandSettings?.[brandSlug]?.webhookSecret
        : undefined) ?? this.options_.webhookSecret
    );
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

      const session = await this.resolveSession(
        webhook.kind === "payment" ? webhook.order.orderKey : undefined,
        webhook.kind === "payment"
          ? (webhook.order.merchantReference ?? webhook.order.reference)
          : webhook.merchantReference,
      );
      if (!session || session.deleted_at || session.status === "canceled") {
        const event = webhook.kind === "payment" ? webhook.event : "risk_alert";
        const orderId =
          webhook.kind === "payment" ? webhook.order.id : undefined;
        this.logger_.warn(
          `[niftipay] ${event} webhook has no live payment session (orderId=${orderId ?? "unknown"})`,
        );
        return unsupported;
      }

      const authenticated = verifyNiftipayWebhook({
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
      if (
        (webhookReference && webhookReference !== session.id) ||
        (webhook.event === "paid" && webhookReference !== session.id)
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
