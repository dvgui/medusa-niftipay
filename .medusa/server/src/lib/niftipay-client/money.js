"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toMinorUnits = exports.currencyMinorUnits = void 0;
const currencyMinorUnits = (currency) => {
    const normalized = currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalized)) {
        throw new Error(`Invalid ISO 4217 currency code: ${currency}`);
    }
    return (new Intl.NumberFormat("en", {
        style: "currency",
        currency: normalized,
    }).resolvedOptions().maximumFractionDigits ?? 2);
};
exports.currencyMinorUnits = currencyMinorUnits;
/**
 * Convert Medusa's major-unit amount (for example 19.95 GBP) to Niftipay's
 * minor-unit field. `Intl` supplies ISO 4217's 0/2/3-decimal currency rules.
 */
const toMinorUnits = (amount, currency) => {
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Payment amount must be a positive finite number");
    }
    const scale = 10 ** (0, exports.currencyMinorUnits)(currency);
    const scaled = amount * scale;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-7) {
        throw new Error(`${amount} has too many decimal places for ${currency}`);
    }
    return rounded;
};
exports.toMinorUnits = toMinorUnits;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uZXkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL25pZnRpcGF5LWNsaWVudC9tb25leS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBTyxNQUFNLGtCQUFrQixHQUFHLENBQUMsUUFBZ0IsRUFBVSxFQUFFO0lBQzdELE1BQU0sVUFBVSxHQUFHLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQTtJQUNoRCxJQUFJLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsRUFBRSxDQUFDO1FBQ25DLE1BQU0sSUFBSSxLQUFLLENBQUMsbUNBQW1DLFFBQVEsRUFBRSxDQUFDLENBQUE7SUFDaEUsQ0FBQztJQUVELE9BQU8sQ0FDTCxJQUFJLElBQUksQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFO1FBQzFCLEtBQUssRUFBRSxVQUFVO1FBQ2pCLFFBQVEsRUFBRSxVQUFVO0tBQ3JCLENBQUMsQ0FBQyxlQUFlLEVBQUUsQ0FBQyxxQkFBcUIsSUFBSSxDQUFDLENBQ2hELENBQUE7QUFDSCxDQUFDLENBQUE7QUFaWSxRQUFBLGtCQUFrQixzQkFZOUI7QUFFRDs7O0dBR0c7QUFDSSxNQUFNLFlBQVksR0FBRyxDQUFDLE1BQWMsRUFBRSxRQUFnQixFQUFVLEVBQUU7SUFDdkUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLElBQUksTUFBTSxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQzVDLE1BQU0sSUFBSSxLQUFLLENBQUMsaURBQWlELENBQUMsQ0FBQTtJQUNwRSxDQUFDO0lBQ0QsTUFBTSxLQUFLLEdBQUcsRUFBRSxJQUFJLElBQUEsMEJBQWtCLEVBQUMsUUFBUSxDQUFDLENBQUE7SUFDaEQsTUFBTSxNQUFNLEdBQUcsTUFBTSxHQUFHLEtBQUssQ0FBQTtJQUM3QixNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFBO0lBQ2xDLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLEdBQUcsT0FBTyxDQUFDLEdBQUcsSUFBSSxFQUFFLENBQUM7UUFDdEMsTUFBTSxJQUFJLEtBQUssQ0FBQyxHQUFHLE1BQU0sb0NBQW9DLFFBQVEsRUFBRSxDQUFDLENBQUE7SUFDMUUsQ0FBQztJQUNELE9BQU8sT0FBTyxDQUFBO0FBQ2hCLENBQUMsQ0FBQTtBQVhZLFFBQUEsWUFBWSxnQkFXeEIifQ==