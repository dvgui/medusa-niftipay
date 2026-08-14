"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.POST = POST;
const utils_1 = require("@medusajs/framework/utils");
const constants_1 = require("../../../constants");
/**
 * Niftipay appends `/niftipay/webhook` to the base origin entered in its
 * dashboard. This adapter preserves its signed bytes and emits the same event
 * as Medusa's built-in `/hooks/payment/:provider` route.
 */
async function POST(req, res) {
    const logger = req.scope.resolve(utils_1.ContainerRegistrationKeys.LOGGER);
    const rawData = req.rawBody;
    if (!rawData) {
        logger.error("[niftipay] raw webhook body unavailable; signature verification cannot run");
        res.status(500).json({ ok: false, error: "raw body unavailable" });
        return;
    }
    try {
        const paymentModule = req.scope.resolve(utils_1.Modules.PAYMENT);
        const eventBus = req.scope.resolve(utils_1.Modules.EVENT_BUS);
        const options = paymentModule.options ?? {};
        await eventBus.emit({
            name: utils_1.PaymentWebhookEvents.WebhookReceived,
            data: {
                provider: constants_1.NIFTIPAY_PROVIDER_ID,
                payload: {
                    data: req.body,
                    rawData,
                    headers: req.headers,
                },
            },
        }, {
            delay: options.webhook_delay ?? 5_000,
            attempts: options.webhook_retries ?? 3,
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[niftipay] failed to queue webhook: ${message}`);
        res.status(400).json({ ok: false, error: "webhook not queued" });
        return;
    }
    res.status(200).json({ ok: true });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9zcmMvYXBpL25pZnRpcGF5L3dlYmhvb2svcm91dGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFtQkEsb0JBZ0RDO0FBakVELHFEQUlrQztBQUVsQyxrREFBeUQ7QUFNekQ7Ozs7R0FJRztBQUNJLEtBQUssVUFBVSxJQUFJLENBQ3hCLEdBQW1CLEVBQ25CLEdBQW1CO0lBRW5CLE1BQU0sTUFBTSxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLGlDQUF5QixDQUFDLE1BQU0sQ0FBQyxDQUFBO0lBQ2xFLE1BQU0sT0FBTyxHQUFHLEdBQUcsQ0FBQyxPQUFPLENBQUE7SUFDM0IsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ2IsTUFBTSxDQUFDLEtBQUssQ0FDViw0RUFBNEUsQ0FDN0UsQ0FBQTtRQUNELEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsc0JBQXNCLEVBQUUsQ0FBQyxDQUFBO1FBQ2xFLE9BQU07SUFDUixDQUFDO0lBRUQsSUFBSSxDQUFDO1FBQ0gsTUFBTSxhQUFhLEdBQUcsR0FBRyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsZUFBTyxDQUFDLE9BQU8sQ0FFdEQsQ0FBQTtRQUNELE1BQU0sUUFBUSxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUNoQyxlQUFPLENBQUMsU0FBUyxDQUNsQixDQUFBO1FBQ0QsTUFBTSxPQUFPLEdBQUcsYUFBYSxDQUFDLE9BQU8sSUFBSSxFQUFFLENBQUE7UUFFM0MsTUFBTSxRQUFRLENBQUMsSUFBSSxDQUNqQjtZQUNFLElBQUksRUFBRSw0QkFBb0IsQ0FBQyxlQUFlO1lBQzFDLElBQUksRUFBRTtnQkFDSixRQUFRLEVBQUUsZ0NBQW9CO2dCQUM5QixPQUFPLEVBQUU7b0JBQ1AsSUFBSSxFQUFFLEdBQUcsQ0FBQyxJQUFJO29CQUNkLE9BQU87b0JBQ1AsT0FBTyxFQUFFLEdBQUcsQ0FBQyxPQUFPO2lCQUNyQjthQUNGO1NBQ0YsRUFDRDtZQUNFLEtBQUssRUFBRSxPQUFPLENBQUMsYUFBYSxJQUFJLEtBQUs7WUFDckMsUUFBUSxFQUFFLE9BQU8sQ0FBQyxlQUFlLElBQUksQ0FBQztTQUN2QyxDQUNGLENBQUE7SUFDSCxDQUFDO0lBQUMsT0FBTyxLQUFjLEVBQUUsQ0FBQztRQUN4QixNQUFNLE9BQU8sR0FBRyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUE7UUFDdEUsTUFBTSxDQUFDLEtBQUssQ0FBQyx1Q0FBdUMsT0FBTyxFQUFFLENBQUMsQ0FBQTtRQUM5RCxHQUFHLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLG9CQUFvQixFQUFFLENBQUMsQ0FBQTtRQUNoRSxPQUFNO0lBQ1IsQ0FBQztJQUVELEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUE7QUFDcEMsQ0FBQyJ9