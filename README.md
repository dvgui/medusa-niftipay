# Medusa Niftipay

A Medusa v2 payment-provider plugin for Niftipay hosted fiat card payments.
It creates hosted payment orders, authenticates asynchronous webhooks, maps
successful payments into Medusa's payment workflow, and supports partial
refunds.

## What Niftipay receives

The provider sends every customer/reference field accepted by Niftipay's fiat
order API:

| Niftipay field      | Medusa source                | Purpose                           |
| ------------------- | ---------------------------- | --------------------------------- |
| `integrationId`     | provider configuration       | Selects the Niftipay integration  |
| `amount`            | payment session              | Charge amount in major units      |
| `currency`          | payment session              | ISO 4217 currency code            |
| `email`             | checkout customer context    | Customer/payment lookup           |
| `description`       | configurable template        | Human-readable cart reference     |
| `reference`         | Medusa payment-session ID    | Unique merchant correlation key   |
| `merchantReference` | Medusa payment-session ID    | Compatibility correlation key     |
| `serviceFeePayer`   | provider configuration       | Merchant or customer              |
| `returnUrl`         | brand/provider configuration | Successful hosted-checkout return |
| `failureUrl`        | brand/provider configuration | Failed hosted-checkout return     |

Niftipay's fiat order API does not currently accept customer names, phone
numbers, billing addresses, or shipping addresses. This plugin therefore does
not transmit them, and it never handles or stores raw card details. The Medusa
payment-session ID is the primary searchable reference in Niftipay; the
description defaults to `Medusa cart {cart_id}`.

## Install

Pin an audited commit, as with other external Medusa payment providers:

```json
{
  "dependencies": {
    "@dvgui/niftipay-plugin": "git+https://github.com/dvgui/medusa-niftipay.git#COMMIT_SHA"
  }
}
```

Register the plugin (which owns `/niftipay/webhook`) and its provider. The
provider `id` must remain `niftipay` because Niftipay uses a fixed webhook path.

```ts
import { defineConfig } from "@medusajs/framework/utils";

export default defineConfig({
  plugins: [
    {
      resolve: "@dvgui/niftipay-plugin",
      options: {},
    },
  ],
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "@dvgui/niftipay-plugin/providers/niftipay",
            id: "niftipay",
            options: {
              apiKey: process.env.NIFTIPAY_API_KEY,
              integrationId: process.env.NIFTIPAY_INTEGRATION_ID,
              webhookSecret: process.env.NIFTIPAY_WEBHOOK_SECRET,
              returnUrl:
                "https://shop.example.com/checkout/niftipay-return?cart_id={cart_id}",
              failureUrl:
                "https://shop.example.com/checkout?step=payment&niftipay=failed",
              allowedCurrencies: ["GBP", "EUR", "USD"],
              allowedRedirectHosts: ["niftipay.com"],
            },
          },
        ],
      },
    },
  ],
});
```

The checkout payment-session data must include `session_id` and `cart_id`. An
optional `niftipay_brand_slug` (falling back to `brand_slug`) selects matching
entries from `brandSettings`. Brand entries can override `integrationId` and
`webhookSecret` as a required pair, allowing one Medusa backend to route
separate storefront integrations while keeping callbacks and webhook
authentication bound to the originating brand.

## Options

| Option                    | Required                            | Default                    |
| ------------------------- | ----------------------------------- | -------------------------- |
| `apiKey`                  | yes                                 | —                          |
| `integrationId`           | yes                                 | —                          |
| `webhookSecret`           | yes                                 | —                          |
| `baseUrl`                 | no                                  | `https://www.niftipay.com` |
| `returnUrl`               | yes unless every brand supplies one | —                          |
| `failureUrl`              | no                                  | —                          |
| `descriptionTemplate`     | no                                  | `Medusa cart {cart_id}`    |
| `brandSettings`           | no                                  | —                          |
| `serviceFeePayer`         | no                                  | `merchant`                 |
| `allowedCurrencies`       | no                                  | all valid ISO currencies   |
| `allowedRedirectHosts`    | no                                  | all HTTPS hosts            |
| `webhookToleranceSeconds` | no                                  | `300`                      |
| `allowLegacyWebhookAuth`  | no                                  | `false`                    |

Description templates support `{cart_id}`, `{session_id}`, and `{brand_slug}`.
Return/failure URL templates support `{cart_id}` and `{session_id}`. All return
and failure URLs must use HTTPS.

## Niftipay dashboard

- Return URL: the public storefront success-return URL.
- Failure URL: the public storefront checkout/payment URL.
- Merchant webhook URL: the public Medusa backend origin only, for example
  `https://backend.example.com`. Niftipay appends `/niftipay/webhook`.
- Separate webhook setting: use the same backend origin and bind it to the
  corresponding integration so the deployment only receives its own events.

The webhook handler authenticates Niftipay's `v1=` HMAC over the exact raw
request body, requires a timestamp within five minutes by default, and verifies
the merchant reference, public order ID, currency, and amount against the
Medusa payment session before marking payment successful.

## Refunds

`refundPayment` uses Niftipay's current
`POST /api/fiat/orders/:orderKey/refunds` endpoint with ISO-correct minor units,
including zero- and three-decimal currencies. It supports partial and multiple
refund requests.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

Commit the generated `.medusa/server` output when consumers install directly
from Git. Never commit API keys, integration IDs, webhook secrets, or customer
payment data.
