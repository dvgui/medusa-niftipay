"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NiftipaySessionStore = void 0;
const safeResolve = (container, keys) => {
    for (const key of keys) {
        try {
            const value = container[key];
            if (value != null)
                return value;
        }
        catch {
            // Awilix cradle proxies throw for unknown registrations.
        }
    }
    return undefined;
};
const FIELDS = [
    "id",
    "status",
    "amount",
    "currency_code",
    "provider_id",
    "data",
    "deleted_at",
];
class NiftipaySessionStore {
    constructor(container, logger) {
        this.container = container;
        this.logger = logger;
    }
    service() {
        return safeResolve(this.container, ["paymentSessionService", "paymentSession"]);
    }
    async load(sessionId) {
        const service = this.service();
        if (service?.retrieve) {
            try {
                return await service.retrieve(sessionId, { select: FIELDS });
            }
            catch {
                // Fall through to Query when the internal service isn't in this scope.
            }
        }
        const query = safeResolve(this.container, ["query", "__query__", "remoteQuery"]);
        if (!query?.graph)
            return null;
        const { data } = await query.graph({
            entity: "payment_session",
            fields: FIELDS,
            filters: { id: sessionId },
        });
        return data[0] ?? null;
    }
    async findByOrderKey(orderKey) {
        const service = this.service();
        if (!service?.list)
            return null;
        const sessions = await service.list({ status: ["pending", "authorized", "captured"] }, { take: 100, order: { created_at: "DESC" }, select: FIELDS });
        return (sessions.find((session) => String(session.provider_id ?? "").includes("niftipay") &&
            String(session.data?.niftipay_order_key ?? "") === orderKey) ?? null);
    }
    async findByCartId(cartId, orderId) {
        const service = this.service();
        if (!service?.list)
            return null;
        const sessions = await service.list({ status: ["pending", "authorized", "captured"] }, { take: 100, order: { created_at: "DESC" }, select: FIELDS });
        const cartSessions = sessions.filter((session) => String(session.provider_id ?? "").includes("niftipay") &&
            String(session.data?.cart_id ?? "") === cartId);
        if (orderId) {
            return (cartSessions.find((session) => String(session.data?.niftipay_order_id ?? "") === orderId) ?? null);
        }
        return cartSessions[0] ?? null;
    }
    async stamp(session, patch) {
        try {
            const service = this.service();
            if (!service?.update)
                return;
            await service.update({
                id: session.id,
                data: { ...(session.data ?? {}), ...patch },
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[niftipay] could not stamp payment session ${session.id}: ${message}`);
        }
    }
}
exports.NiftipaySessionStore = NiftipaySessionStore;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2Vzc2lvbi1zdG9yZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvbmlmdGlwYXkvc2Vzc2lvbi1zdG9yZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFZQSxNQUFNLFdBQVcsR0FBRyxDQUNsQixTQUFrQyxFQUNsQyxJQUF1QixFQUNSLEVBQUU7SUFDakIsS0FBSyxNQUFNLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztRQUN2QixJQUFJLENBQUM7WUFDSCxNQUFNLEtBQUssR0FBRyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUE7WUFDNUIsSUFBSSxLQUFLLElBQUksSUFBSTtnQkFBRSxPQUFPLEtBQVUsQ0FBQTtRQUN0QyxDQUFDO1FBQUMsTUFBTSxDQUFDO1lBQ1AseURBQXlEO1FBQzNELENBQUM7SUFDSCxDQUFDO0lBQ0QsT0FBTyxTQUFTLENBQUE7QUFDbEIsQ0FBQyxDQUFBO0FBRUQsTUFBTSxNQUFNLEdBQUc7SUFDYixJQUFJO0lBQ0osUUFBUTtJQUNSLFFBQVE7SUFDUixlQUFlO0lBQ2YsYUFBYTtJQUNiLE1BQU07SUFDTixZQUFZO0NBQ2IsQ0FBQTtBQUVELE1BQWEsb0JBQW9CO0lBQy9CLFlBQ21CLFNBQWtDLEVBQ2xDLE1BQWM7UUFEZCxjQUFTLEdBQVQsU0FBUyxDQUF5QjtRQUNsQyxXQUFNLEdBQU4sTUFBTSxDQUFRO0lBQzlCLENBQUM7SUFFSSxPQUFPO1FBQ2IsT0FBTyxXQUFXLENBVWYsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDLHVCQUF1QixFQUFFLGdCQUFnQixDQUFDLENBQUMsQ0FBQTtJQUNqRSxDQUFDO0lBRUQsS0FBSyxDQUFDLElBQUksQ0FBQyxTQUFpQjtRQUMxQixNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUE7UUFDOUIsSUFBSSxPQUFPLEVBQUUsUUFBUSxFQUFFLENBQUM7WUFDdEIsSUFBSSxDQUFDO2dCQUNILE9BQU8sTUFB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