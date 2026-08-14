import { ModuleProvider, Modules } from "@medusajs/framework/utils"

import NiftipayPaymentProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [NiftipayPaymentProviderService],
})
