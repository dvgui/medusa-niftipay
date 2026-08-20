import { afterEach, describe, expect, it, mock } from "bun:test";
import { PaymentActions } from "@medusajs/framework/utils";

import { signNiftipayWebhook } from "../../lib/niftipay-client/webhook";
import NiftipayPaymentProviderService from "./service";

const secret = "niftipay-test-secret-at-least-32-chars";
const ukSecret = "niftipay-uk-secret-at-least-32-chars";
const sessionId = "payses_01M00JVM2YDY19TTT5D7FRGGHA";
const cartId = "cart_01M00JTNERMHY7Q4BS2XZSW4KZ";
const orderId = "3f71d8b4-2151-4a01-9346-4a1c1ca1d650";
const originalFetch = globalThis.fetch;

const logger = () => ({
  debug: mock(() => undefined),
  info: mock(() => undefined),
  warn: mock(() => undefined),
  error: mock(() => undefined),
});

const options = {
  apiKey: "test-api-key",
  integrationId: "test-integration-id",
  webhookSecret: secret,
  returnUrl: "https://store.example/payment-return/{cart_id}",
  failureUrl: "https://store.example/payment-failed/{cart_id}",
  descriptionTemplate:
    "Medusa {brand_slug} cart {cart_id} — {customer_name}",
};

const brandOptions = {
  ...options,
  brandSettings: {
    buyreta_uk: {
      apiKey: "buyreta-uk-api-key",
      integrationId: "buyreta-uk-integration-id",
      webhookSecret: ukSecret,
      returnUrl: "https://uk.example/payment-return/{cart_id}",
      failureUrl: "https://uk.example/payment-failed/{cart_id}",
    },
  },
};

const refundPaymentData = {
  session_id: sessionId,
  niftipay_order_id: orderId,
  niftipay_order_key: "legacy-stored-key",
  niftipay_integration_id: "test-integration-id",
  niftipay_merchant_reference: cartId,
  niftipay_currency: "GBP",
};

const refundableRemoteOrder = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: orderId,
  orderKey: 33351,
  integrationId: "test-integration-id",
  merchantReference: cartId,
  currency: "GBP",
  status: "completed",
  pspOrderId: "processor-order-id",
  pspStatus: "completed",
  pspTransactionCount: 1,
  ...overrides,
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Niftipay payment initiation", () => {
  it("sends every supported lookup field without leaking the webhook secret", async () => {
    const requests: Array<{
      input: string | URL | Request;
      init?: RequestInit;
    }> = [];
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input, init });
        return new Response(
          JSON.stringify({
            order: {
              id: orderId,
              orderKey: 33351,
              status: "new",
            },
            payUrl: `https://www.niftipay.com/paylink/${orderId}`,
            reference: sessionId,
          }),
          { status: 201 },
        );
      },
    ) as unknown as typeof fetch;

    const service = new NiftipayPaymentProviderService(
      { logger: logger() } as never,
      options,
    );
    const result = await service.initiatePayment({
      amount: 10,
      currency_code: "gbp",
      context: { customer: { email: "customer@example.com" } },
      data: {
        session_id: sessionId,
        cart_id: cartId,
        niftipay_merchant_reference: cartId,
        brand_slug: "buyreta_uk",
        customer_name: "  Ada   Lovelace  ",
        phone: "+44 7700 900000",
        shipping_address: { address_1: "1 Example Street" },
      },
    } as never);

    expect(requests).toHaveLength(1);
    const request = requests[0];
    const body = JSON.parse(String(request.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      integrationId: "test-integration-id",
      currency: "GBP",
      amount: 10,
      email: "customer@example.com",
      description: `Medusa buyreta_uk cart ${cartId} — Ada Lovelace`,
      reference: sessionId,
      merchantReference: cartId,
      serviceFeePayer: "merchant",
      returnUrl: `https://store.example/payment-return/${cartId}`,
      failureUrl: `https://store.example/payment-failed/${cartId}`,
    });
    expect(body).not.toHaveProperty("webhookSecret");
    expect(body).not.toHaveProperty("customerName");
    expect(body).not.toHaveProperty("phone");
    expect(body).not.toHaveProperty("shipping_address");
    expect(request.init?.headers).toEqual(
      expect.objectContaining({ "x-api-key": "test-api-key" }),
    );
    expect(request.init?.headers).not.toEqual(
      expect.objectContaining({ Authorization: expect.anything() }),
    );
    expect(result.data).toEqual(
      expect.objectContaining({
        niftipay_order_id: orderId,
        niftipay_order_key: "33351",
        niftipay_reference: sessionId,
        niftipay_merchant_reference: cartId,
        niftipay_email: "customer@example.com",
        niftipay_customer_name: "Ada Lovelace",
      }),
    );
  });

  it("preflights the public order ID and refunds the canonical key once", async () => {
    const requests: Array<{
      input: string | URL | Request;
      init?: RequestInit;
    }> = [];
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input, init });
        if (init?.method === "GET") {
          return new Response(
            JSON.stringify({ order: refundableRemoteOrder() }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      },
    ) as unknown as typeof fetch;

    const service = new NiftipayPaymentProviderService(
      { logger: logger() } as never,
      options,
    );
    const result = await service.refundPayment({
      amount: 2.5,
      data: refundPaymentData,
    } as never);

    expect(requests).toHaveLength(2);
    expect(requests[0].init?.method).toBe("GET");
    expect(String(requests[0].input)).toEndWith(
      `/api/fiat/orders/${orderId}`,
    );
    expect(requests[1].init?.method).toBe("POST");
    expect(String(requests[1].input)).toEndWith(
      "/api/fiat/orders/33351/refunds",
    );
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({
      amountCents: 250,
      description: `Medusa refund for ${sessionId}`,
    });
    expect(result.data).toEqual(
      expect.objectContaining({
        niftipay_order_id: orderId,
        niftipay_order_key: "33351",
        niftipay_status: "refund_requested",
        niftipay_last_refund_amount: 2.5,
      }),
    );
  });

  it("falls back to the stored key for a read-only lookup before one refund POST", async () => {
    const requests: Array<{
      input: string | URL | Request;
      init?: RequestInit;
    }> = [];
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input, init });
        if (init?.method === "GET" && String(input).endsWith(`/${orderId}`)) {
          return new Response(JSON.stringify({ message: "Not found" }), {
            status: 404,
          });
        }
        if (init?.method === "GET") {
          return new Response(
            JSON.stringify({ order: refundableRemoteOrder() }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      },
    ) as unknown as typeof fetch;

    const service = new NiftipayPaymentProviderService(
      { logger: logger() } as never,
      options,
    );
    await service.refundPayment({
      amount: 2.5,
      data: refundPaymentData,
    } as never);

    expect(requests.map(({ init }) => init?.method)).toEqual([
      "GET",
      "GET",
      "POST",
    ]);
    expect(String(requests[1].input)).toEndWith(
      "/api/fiat/orders/legacy-stored-key",
    );
    expect(String(requests[2].input)).toEndWith(
      "/api/fiat/orders/33351/refunds",
    );
  });

  it("never retries an ambiguous refund mutation under another identifier", async () => {
    const requests: Array<{
      input: string | URL | Request;
      init?: RequestInit;
    }> = [];
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input, init });
        if (init?.method === "GET") {
          return new Response(
            JSON.stringify({ order: refundableRemoteOrder() }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ message: "Processor transaction unavailable" }),
          { status: 500 },
        );
      },
    ) as unknown as typeof fetch;

    const service = new NiftipayPaymentProviderService(
      { logger: logger() } as never,
      options,
    );
    await expect(
      service.refundPayment({
        amount: 2.5,
        data: refundPaymentData,
      } as never),
    ).rejects.toThrow("Processor transaction unavailable");

    expect(requests.map(({ init }) => init?.method)).toEqual(["GET", "POST"]);
    expect(String(requests[1].input)).toEndWith(
      "/api/fiat/orders/33351/refunds",
    );
  });

  it.each([
    ["public order ID", { id: "different-order-id" }],
    ["integration", { integrationId: "different-integration" }],
    ["currency", { currency: "EUR" }],
    ["merchant reference", { merchantReference: "cart_different" }],
    ["PSP order", { pspOrderId: undefined }],
    ["PSP transaction", { pspTransactionCount: 0 }],
  ])(
    "rejects a mismatched or incomplete %s before refunding",
    async (_, remoteOverrides) => {
      const requests: Array<{
        input: string | URL | Request;
        init?: RequestInit;
      }> = [];
      globalThis.fetch = mock(
        async (input: string | URL | Request, init?: RequestInit) => {
          requests.push({ input, init });
          return new Response(
            JSON.stringify({
              order: refundableRemoteOrder(remoteOverrides),
            }),
            { status: 200 },
          );
        },
      ) as unknown as typeof fetch;

      const service = new NiftipayPaymentProviderService(
        { logger: logger() } as never,
        options,
      );
      await expect(
        service.refundPayment({
          amount: 2.5,
          data: refundPaymentData,
        } as never),
      ).rejects.toThrow();

      expect(requests).toHaveLength(1);
      expect(requests[0].init?.method).toBe("GET");
    },
  );

  it("selects a brand-specific integration without exposing its webhook secret", async () => {
    const requests: Array<{
      input: string | URL | Request;
      init?: RequestInit;
    }> = [];
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input, init });
        return new Response(
          JSON.stringify({
            order: { id: orderId, orderKey: 33351, status: "new" },
            payUrl: `https://www.niftipay.com/paylink/${orderId}`,
            reference: sessionId,
          }),
          { status: 201 },
        );
      },
    ) as unknown as typeof fetch;

    const service = new NiftipayPaymentProviderService(
      { logger: logger() } as never,
      brandOptions,
    );
    const result = await service.initiatePayment({
      amount: 10,
      currency_code: "gbp",
      context: { customer: { email: "customer@example.com" } },
      data: {
        session_id: sessionId,
        cart_id: cartId,
        brand_slug: "buyretauk_com",
        niftipay_brand_slug: "buyreta_uk",
      },
    } as never);

    const body = JSON.parse(String(requests[0].init?.body)) as Record<
      string,
      unknown
    >;
    expect(body.integrationId).toBe("buyreta-uk-integration-id");
    expect(requests[0].init?.headers).toEqual(
      expect.objectContaining({ "x-api-key": "buyreta-uk-api-key" }),
    );
    expect(body.returnUrl).toBe(`https://uk.example/payment-return/${cartId}`);
    expect(body).not.toHaveProperty("webhookSecret");
    expect(result.data).toEqual(
      expect.objectContaining({
        brand_slug: "buyreta_uk",
        niftipay_integration_id: "buyreta-uk-integration-id",
      }),
    );
  });

  it("uses the stored integration's API key for refund lookup and mutation", async () => {
    const requests: Array<{
      input: string | URL | Request;
      init?: RequestInit;
    }> = [];
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input, init });
        if (init?.method === "GET") {
          return new Response(
            JSON.stringify({
              order: refundableRemoteOrder({
                integrationId: "buyreta-uk-integration-id",
              }),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      },
    ) as unknown as typeof fetch;

    const service = new NiftipayPaymentProviderService(
      { logger: logger() } as never,
      brandOptions,
    );
    await service.refundPayment({
      amount: 2.5,
      data: {
        ...refundPaymentData,
        niftipay_integration_id: "buyreta-uk-integration-id",
      },
    } as never);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.init?.headers).toEqual(
        expect.objectContaining({ "x-api-key": "buyreta-uk-api-key" }),
      );
    }
  });
});

const buildWebhookService = ({
  storedOrderId,
  storedIntegrationId,
  brandSlug,
  serviceOptions = options,
  sessionExists = true,
}: {
  storedOrderId?: string;
  storedIntegrationId?: string;
  brandSlug?: string;
  serviceOptions?: typeof options | typeof brandOptions;
  sessionExists?: boolean;
} = {}) => {
  const update = mock(async () => undefined);
  const emit = mock(async () => undefined);
  const testLogger = logger();
  const session = {
      id: sessionId,
      status: "pending",
      amount: 10,
      currency_code: "gbp",
      provider_id: "pp_niftipay_niftipay",
      data: {
        session_id: sessionId,
        cart_id: cartId,
        niftipay_merchant_reference: cartId,
        niftipay_order_key: "33351",
        niftipay_reference: sessionId,
        niftipay_currency: "GBP",
        ...(storedIntegrationId
          ? { niftipay_integration_id: storedIntegrationId }
          : {}),
        ...(brandSlug ? { brand_slug: brandSlug } : {}),
        ...(storedOrderId ? { niftipay_order_id: storedOrderId } : {}),
      },
    };
  const paymentSessionService = {
    retrieve: mock(async () => {
      if (!sessionExists) throw new Error(`PaymentSession ${sessionId} not found`);
      return session;
    }),
    list: mock(async () => (sessionExists ? [session] : [])),
    update,
  };
  const service = new NiftipayPaymentProviderService(
    {
      logger: testLogger,
      paymentSessionService,
      event_bus: { emit },
    } as never,
    serviceOptions,
  );
  return { emit, logger: testLogger, service, update };
};

const signedPayload = (
  id = orderId,
  signingSecret = secret,
  integrationId?: string,
  merchantReference = sessionId,
) => {
  const data = {
    event: "paid",
    order: {
      id,
      ...(integrationId ? { integrationId } : {}),
      currency: "GBP",
      amountCents: 1000,
      subtotalCents: 1000,
      status: "completed",
      merchantReference,
      email: "customer@example.com",
      completedAt: "2026-08-17T07:39:56.092Z",
    },
  };
  const rawData = JSON.stringify(data);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    data,
    rawData,
    headers: {
      "x-timestamp": timestamp,
      "x-signature": `v1=${signNiftipayWebhook(timestamp, rawData, signingSecret)}`,
    },
  };
};

describe("Niftipay fiat webhooks", () => {
  it("resolves a live payment session from the durable cart merchant reference", async () => {
    const { service, update } = buildWebhookService({
      storedOrderId: orderId,
      storedIntegrationId: "test-integration-id",
    });
    const result = await service.getWebhookActionAndData(
      signedPayload(
        orderId,
        secret,
        "test-integration-id",
        cartId,
      ) as never,
    );

    expect(result.action).toBe(PaymentActions.SUCCESSFUL);
    expect(update).toHaveBeenCalled();
  });

  it("emits an authenticated orphan-paid event for a missing cart-referenced session", async () => {
    const { emit, service } = buildWebhookService({ sessionExists: false });
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          order: {
            id: orderId,
            integrationId: "test-integration-id",
            orderKey: "33351",
            merchantReference: cartId,
            status: "completed",
            currency: "GBP",
            amountCents: 1000,
            subtotalCents: 1000,
            email: "customer@example.com",
            completedAt: "2026-08-17T07:39:56.092Z",
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await service.getWebhookActionAndData(
      signedPayload(
        orderId,
        secret,
        "test-integration-id",
        cartId,
      ) as never,
    );

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED);
    expect(emit).toHaveBeenCalledWith({
      name: "payment.niftipay_orphan_paid",
      data: expect.objectContaining({
        cartId,
        niftipayOrderId: orderId,
        niftipayOrderKey: "33351",
        merchantReference: cartId,
        amountMinor: 1000,
        currencyCode: "GBP",
        customerEmail: "customer@example.com",
        integrationId: "test-integration-id",
      }),
    });
  });

  it("uses the webhook integration's API key for orphan status lookup", async () => {
    const requests: Array<{
      input: string | URL | Request;
      init?: RequestInit;
    }> = [];
    const { emit, service } = buildWebhookService({
      serviceOptions: brandOptions,
      sessionExists: false,
    });
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input, init });
        return new Response(
          JSON.stringify({
            order: {
              id: orderId,
              integrationId: "buyreta-uk-integration-id",
              orderKey: "33351",
              merchantReference: cartId,
              status: "completed",
              currency: "GBP",
              amountCents: 1000,
              subtotalCents: 1000,
              email: "customer@example.com",
              completedAt: "2026-08-17T07:39:56.092Z",
            },
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    await service.getWebhookActionAndData(
      signedPayload(
        orderId,
        ukSecret,
        "buyreta-uk-integration-id",
        cartId,
      ) as never,
    );

    expect(emit).toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0].init?.headers).toEqual(
      expect.objectContaining({ "x-api-key": "buyreta-uk-api-key" }),
    );
  });

  it("does not attach an old paid attempt to a newer live session on the same cart", async () => {
    const { emit, service, update } = buildWebhookService({
      storedOrderId: "replacement-order-id",
      storedIntegrationId: "test-integration-id",
    });
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          order: {
            id: orderId,
            integrationId: "test-integration-id",
            orderKey: "33351",
            merchantReference: cartId,
            status: "completed",
            currency: "GBP",
            amountCents: 1000,
            subtotalCents: 1000,
            email: "customer@example.com",
            completedAt: "2026-08-17T07:39:56.092Z",
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await service.getWebhookActionAndData(
      signedPayload(
        orderId,
        secret,
        "test-integration-id",
        cartId,
      ) as never,
    );

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED);
    expect(update).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "payment.niftipay_orphan_paid",
      }),
    );
  });

  it("never emits orphan recovery for an invalid signature", async () => {
    const { emit, service } = buildWebhookService({ sessionExists: false });
    const result = await service.getWebhookActionAndData(
      signedPayload(
        orderId,
        "wrong-secret-at-least-32-characters",
        "test-integration-id",
        cartId,
      ) as never,
    );

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED);
    expect(emit).not.toHaveBeenCalled();
  });

  it("never emits orphan recovery for an unknown integration", async () => {
    const { emit, service } = buildWebhookService({ sessionExists: false });
    const result = await service.getWebhookActionAndData(
      signedPayload(orderId, secret, "unknown-integration", cartId) as never,
    );

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED);
    expect(emit).not.toHaveBeenCalled();
  });

  it("accepts the documented paid payload without an internal orderKey", async () => {
    const { service, update } = buildWebhookService();
    const result = await service.getWebhookActionAndData(
      signedPayload() as never,
    );

    expect(result.action).toBe(PaymentActions.SUCCESSFUL);
    expect(result.data.session_id).toBe(sessionId);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: sessionId,
        data: expect.objectContaining({
          niftipay_order_id: orderId,
          niftipay_status: "paid",
        }),
      }),
    );
  });

  it("rejects a public order ID that does not match the stored order", async () => {
    const {
      logger: testLogger,
      service,
      update,
    } = buildWebhookService({ storedOrderId: orderId });
    const result = await service.getWebhookActionAndData(
      signedPayload("different-fiat-order") as never,
    );

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED);
    expect(update).not.toHaveBeenCalled();
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("public order ID mismatch"),
    );
  });

  it("accepts only the webhook secret bound to the payment session's brand", async () => {
    const { service, update } = buildWebhookService({
      brandSlug: "buyreta_uk",
      serviceOptions: brandOptions,
    });

    const wrongSecretResult = await service.getWebhookActionAndData(
      signedPayload(
        orderId,
        secret,
        "buyreta-uk-integration-id",
      ) as never,
    );
    expect(wrongSecretResult.action).toBe(PaymentActions.NOT_SUPPORTED);
    expect(update).not.toHaveBeenCalled();

    const result = await service.getWebhookActionAndData(
      signedPayload(
        orderId,
        ukSecret,
        "buyreta-uk-integration-id",
      ) as never,
    );
    expect(result.action).toBe(PaymentActions.SUCCESSFUL);
    expect(update).toHaveBeenCalled();
  });

  it("resolves the webhook secret directly from the documented integration ID", async () => {
    const { service, update } = buildWebhookService({
      storedIntegrationId: "buyreta-uk-integration-id",
      serviceOptions: brandOptions,
    });

    const result = await service.getWebhookActionAndData(
      signedPayload(
        orderId,
        ukSecret,
        "buyreta-uk-integration-id",
      ) as never,
    );

    expect(result.action).toBe(PaymentActions.SUCCESSFUL);
    expect(update).toHaveBeenCalled();
  });

  it("rejects an authenticated webhook whose integration does not match the session", async () => {
    const {
      logger: testLogger,
      service,
      update,
    } = buildWebhookService({
      storedIntegrationId: "buyreta-uk-integration-id",
      serviceOptions: brandOptions,
    });

    const result = await service.getWebhookActionAndData(
      signedPayload(orderId, secret, "test-integration-id") as never,
    );

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED);
    expect(update).not.toHaveBeenCalled();
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("integration mismatch"),
    );
  });
});
