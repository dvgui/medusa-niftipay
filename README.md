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
| `reference`         | Medusa payment-session ID    | Live-session correlation key      |
| `merchantReference` | Medusa cart ID               | Durable late-webhook recovery key  |
| `serviceFeePayer`   | provider configuration       | Merchant or customer              |
| `returnUrl`         | brand/provider configuration | Successful hosted-checkout return |
| `failureUrl`        | brand/provider configuration | Failed hosted-checkout return     |

Niftipay's fiat order API currently accepts `email` as its only structured
customer field. It does not expose separate customer-name, phone, billing, or
shipping fields. The plugin can include the normalized checkout name in the
supported `description` field through the `{customer_name}` template token; it
does not invent undocumented request keys, and it never handles raw card
details. The cart ID is the durable searchable reference in Niftipay. Medusa
deliberately deletes stale payment sessions whenever a cart total changes,
while the cart survives; keeping the cart ID in `merchantReference` makes a
late completed payment recoverable without guessing by customer email.

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
entries from `brandSettings`. Brand entries can override `apiKey`, while
`integrationId` and `webhookSecret` remain a required pair. This allows one
Medusa backend to route storefronts across separate Niftipay accounts and
integrations while keeping outbound API calls, callbacks, and webhook
authentication bound to the originating brand. A brand without an `apiKey`
override continues to use the provider-wide key.

```ts
brandSettings: {
  peppys_uk: {
    apiKey: process.env.BRAND_PEPPYS_UK_NIFTIPAY_API_KEY,
    integrationId:
      process.env.BRAND_PEPPYS_UK_NIFTIPAY_INTEGRATION_ID,
    webhookSecret:
      process.env.BRAND_PEPPYS_UK_NIFTIPAY_WEBHOOK_SECRET,
  },
}
```

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

Description templates support `{cart_id}`, `{session_id}`, `{brand_slug}`, and
`{customer_name}`. Customer names are whitespace-normalized and capped at 120
characters before rendering; the final Niftipay description remains capped at
255 characters.
Return/failure URL templates support `{cart_id}` and `{session_id}`. All return
and failure URLs must use HTTPS.

Current fiat webhooks include `order.integrationId`. The provider resolves the
API key and webhook secret from that integration ID, authenticates the
signature, and then requires it to match the integration stored on the Medusa
payment session. The API key is used only for the follow-up status lookup; it is
never stored in payment-session data or logged.
Legacy webhook payloads without `integrationId` fall back to the session's
stored integration/brand credentials.

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

If the exact session was deleted or canceled, an integration-bound authenticated
`paid` webhook is checked against Niftipay's status API and emitted as
`payment.niftipay_orphan_paid` with the durable cart ID. The host backend owns
the idempotent recovery workflow. A webhook for an older attempt is never
attached to a newer session on the same cart: cart lookup also requires the
public Niftipay order UUID. Legacy attempts whose merchant reference is only a
deleted `payses_...` ID remain manual-recovery cases because they contain no
durable cart identifier.

## Refunds

`refundPayment` uses Niftipay's current
`POST /api/fiat/orders/:orderKey/refunds` endpoint with ISO-correct minor units,
including zero- and three-decimal currencies. It supports partial and multiple
refund requests.

Before that single mutation, the provider performs an authenticated read-only
lookup using the stored public order UUID first and the stored order key as a
fallback. It uses the lookup's canonical order key only after matching the
public UUID, integration, currency, and merchant/cart reference to Medusa's
captured payment and confirming that Niftipay exposes a PSP order/transaction
record. This recovers a stale internal key without ever guessing which payment
to refund. Lookup failures may fall back to the other stored identifier; a
refund POST is never retried under another identifier because an HTTP failure
can be ambiguous after a processor-side mutation.

If the preflight reports that the PSP order or transaction record is missing,
the condition is upstream of Medusa. Give Niftipay support the public order UUID
and canonical order key; Medusa cannot safely manufacture that processor
record or bypass it with a second mutation.

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
