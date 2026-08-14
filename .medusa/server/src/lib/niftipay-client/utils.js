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
const optionalNumber = (value) => {
    const numeric = typeof value === "number" ? value : Number(value);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidXRpbHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL25pZnRpcGF5LWNsaWVudC91dGlscy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFFTyxNQUFNLFFBQVEsR0FBRyxDQUFDLEtBQWMsRUFBMEIsRUFBRSxDQUNqRSxPQUFPLEtBQUssS0FBSyxRQUFRLElBQUksS0FBSyxLQUFLLElBQUksSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUE7QUFEekQsUUFBQSxRQUFRLFlBQ2lEO0FBRS9ELE1BQU0sY0FBYyxHQUFHLENBQUMsS0FBYyxFQUFzQixFQUFFO0lBQ25FLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtRQUFFLE9BQU8sS0FBSyxDQUFDLElBQUksRUFBRSxJQUFJLFNBQVMsQ0FBQTtJQUMvRCxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFBO0lBQzdFLE9BQU8sU0FBUyxDQUFBO0FBQ2xCLENBQUMsQ0FBQTtBQUpZLFFBQUEsY0FBYyxrQkFJMUI7QUFFTSxNQUFNLGNBQWMsR0FBRyxDQUFDLEtBQWMsRUFBc0IsRUFBRTtJQUNuRSxNQUFNLE9BQU8sR0FBRyxPQUFPLEtBQUssS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFBO0lBQ2pFLE9BQU8sTUFBTSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUE7QUFDdkQsQ0FBQyxDQUFBO0FBSFksUUFBQSxjQUFjLGtCQUcxQjtBQUVNLE1BQU0sZUFBZSxHQUFHLENBQUMsS0FBYyxFQUFVLEVBQUUsQ0FDeEQsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFBO0FBRDNDLFFBQUEsZUFBZSxtQkFDNEI7QUFFakQsTUFBTSxlQUFlLEdBQUcsQ0FBQyxJQUFhLEVBQUUsUUFBZ0IsRUFBVSxFQUFFO0lBQ3pFLElBQUksQ0FBQyxJQUFBLGdCQUFRLEVBQUMsSUFBSSxDQUFDO1FBQUUsT0FBTyxRQUFRLENBQUE7SUFDcEMsT0FBTyxJQUFBLHNCQUFjLEVBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLElBQUEsc0JBQWMsRUFBQyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksUUFBUSxDQUFBO0FBQy9FLENBQUMsQ0FBQTtBQUhZLFFBQUEsZUFBZSxtQkFHM0IifQ==