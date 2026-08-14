import { defineMiddlewares } from "@medusajs/framework/http"

import { NIFTIPAY_WEBHOOK_PATH } from "../constants"

export default defineMiddlewares({
  routes: [
    {
      matcher: NIFTIPAY_WEBHOOK_PATH,
      methods: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
  ],
})
