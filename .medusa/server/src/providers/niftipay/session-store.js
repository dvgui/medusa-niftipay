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