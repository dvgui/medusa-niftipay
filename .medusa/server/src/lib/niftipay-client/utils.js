"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.responseMessage = exports.getErrorMessage = exports.optionalNumber = exports.optionalString = exports.isRecord = void 0;
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
exports.isRecord = isRecord;
const optionalString = (value) => {
    if (typeof value === "string")
        return value.trim() || undefined;
    if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    return undefined;
};
exports.optionalString = optionalString;
/**
 * Coerce a value to a finite number, understanding Medusa's BigNumber shapes.
 *
 * Medusa hands money amounts to providers as `BigNumberInput`. A BigNumber
 * INSTANCE survives `Number()` through its `valueOf()`, but the payment module
 * passes `refund.raw_amount` / `capture.raw_amount` — the plain
 * `{ value, precision }` row shape, which `Number()` turns into NaN. Treating
 * that as "no amount given" made every admin refund fail with
 * "Niftipay refund amount and currency are required".
 */
const optionalNumber = (value) => {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if ((0, exports.isRecord)(value)) {
        // Medusa BigNumber instance.
        if (typeof value.numeric === "number" && Number.isFinite(value.numeric)) {
            return value.numeric;
        }
        // Raw { value, precision } row shape.
        if ("value" in value)
            return (0, exports.optionalNumber)(value.value);
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
};
exports.optionalNumber = optionalNumber;
const getErrorMessage = (error) => error instanceof Error ? error.message : String(error);
exports.getErrorMessage = getErrorMessage;
const responseMessage = (body, fallback) => {
    if (!(0, exports.isRecord)(body))
        return fallback;
    return (0, exports.optionalString)(body.error) ?? (0, exports.optionalString)(body.message) ?? fallback;
};
exports.responseMessage = responseMessage;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidXRpbHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL25pZnRpcGF5LWNsaWVudC91dGlscy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFFTyxNQUFNLFFBQVEsR0FBRyxDQUFDLEtBQWMsRUFBMEIsRUFBRSxDQUNqRSxPQUFPLEtBQUssS0FBSyxRQUFRLElBQUksS0FBSyxLQUFLLElBQUksSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUE7QUFEekQsUUFBQSxRQUFRLFlBQ2lEO0FBRS9ELE1BQU0sY0FBYyxHQUFHLENBQUMsS0FBYyxFQUFzQixFQUFFO0lBQ25FLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtRQUFFLE9BQU8sS0FBSyxDQUFDLElBQUksRUFBRSxJQUFJLFNBQVMsQ0FBQTtJQUMvRCxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFBO0lBQzdFLE9BQU8sU0FBUyxDQUFBO0FBQ2xCLENBQUMsQ0FBQTtBQUpZLFFBQUEsY0FBYyxrQkFJMUI7QUFFRDs7Ozs7Ozs7O0dBU0c7QUFDSSxNQUFNLGNBQWMsR0FBRyxDQUFDLEtBQWMsRUFBc0IsRUFBRTtJQUNuRSxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzlCLE9BQU8sTUFBTSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUE7SUFDbkQsQ0FBQztJQUVELElBQUksSUFBQSxnQkFBUSxFQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDcEIsNkJBQTZCO1FBQzdCLElBQUksT0FBTyxLQUFLLENBQUMsT0FBTyxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ3hFLE9BQU8sS0FBSyxDQUFDLE9BQU8sQ0FBQTtRQUN0QixDQUFDO1FBQ0Qsc0NBQXNDO1FBQ3RDLElBQUksT0FBTyxJQUFJLEtBQUs7WUFBRSxPQUFPLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUE7SUFDMUQsQ0FBQztJQUVELE1BQU0sT0FBTyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQTtJQUM3QixPQUFPLE1BQU0sQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFBO0FBQ3ZELENBQUMsQ0FBQTtBQWhCWSxRQUFBLGNBQWMsa0JBZ0IxQjtBQUVNLE1BQU0sZUFBZSxHQUFHLENBQUMsS0FBYyxFQUFVLEVBQUUsQ0FDeEQsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFBO0FBRDNDLFFBQUEsZUFBZSxtQkFDNEI7QUFFakQsTUFBTSxlQUFlLEdBQUcsQ0FBQyxJQUFhLEVBQUUsUUFBZ0IsRUFBVSxFQUFFO0lBQ3pFLElBQUksQ0FBQyxJQUFBLGdCQUFRLEVBQUMsSUFBSSxDQUFDO1FBQUUsT0FBTyxRQUFRLENBQUE7SUFDcEMsT0FBTyxJQUFBLHNCQUFjLEVBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLElBQUEsc0JBQWMsRUFBQyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksUUFBUSxDQUFBO0FBQy9FLENBQUMsQ0FBQTtBQUhZLFFBQUEsZUFBZSxtQkFHM0IifQ==