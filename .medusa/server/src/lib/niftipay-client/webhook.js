"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyNiftipayWebhook = exports.signNiftipayWebhook = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const utils_1 = require("./utils");
const headerValue = (headers, name) => {
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    const value = Array.isArray(entry) ? entry[0] : entry;
    return (0, utils_1.optionalString)(value);
};
const timingSafeHexEqual = (left, right) => {
    if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) {
        return false;
    }
    return node_crypto_1.default.timingSafeEqual(Buffer.from(left.toLowerCase(), "hex"), Buffer.from(right.toLowerCase(), "hex"));
};
const signNiftipayWebhook = (timestamp, rawBody, secret) => node_crypto_1.default
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
exports.signNiftipayWebhook = signNiftipayWebhook;
const verifyNiftipayWebhook = ({ rawBody, headers, data, options, }) => {
    const timestamp = headerValue(headers, "x-timestamp");
    const signature = headerValue(headers, "x-signature");
    if (timestamp || signature) {
        if (!timestamp ||
            !signature?.startsWith("v1=") ||
            !/^\d{9,12}$/.test(timestamp)) {
            return false;
        }
        const timestampSeconds = Number(timestamp);
        const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
        if (!Number.isFinite(timestampSeconds) ||
            Math.abs(nowSeconds - timestampSeconds) > options.toleranceSeconds) {
            return false;
        }
        return timingSafeHexEqual(signature.slice(3), (0, exports.signNiftipayWebhook)(timestamp, rawBody, options.secret));
    }
    if (!options.allowLegacy)
        return false;
    const headerSecret = headerValue(headers, "x-webhook-secret");
    const bodySecret = (0, utils_1.isRecord)(data)
        ? (0, utils_1.optionalString)(data.webhookSecret)
        : undefined;
    const supplied = headerSecret ?? bodySecret;
    if (!supplied)
        return false;
    const suppliedBytes = Buffer.from(supplied, "utf8");
    const expectedBytes = Buffer.from(options.secret, "utf8");
    return (suppliedBytes.length === expectedBytes.length &&
        node_crypto_1.default.timingSafeEqual(suppliedBytes, expectedBytes));
};
exports.verifyNiftipayWebhook = verifyNiftipayWebhook;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2ViaG9vay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9saWIvbmlmdGlwYXktY2xpZW50L3dlYmhvb2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBQUEsOERBQWdDO0FBRWhDLG1DQUFrRDtBQVNsRCxNQUFNLFdBQVcsR0FBRyxDQUNsQixPQUFnQyxFQUNoQyxJQUFZLEVBQ1EsRUFBRTtJQUN0QixNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FDeEMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsV0FBVyxFQUFFLEtBQUssSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUNwRCxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUE7SUFDTixNQUFNLEtBQUssR0FBRyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQTtJQUNyRCxPQUFPLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsQ0FBQTtBQUM5QixDQUFDLENBQUE7QUFFRCxNQUFNLGtCQUFrQixHQUFHLENBQUMsSUFBWSxFQUFFLEtBQWEsRUFBVyxFQUFFO0lBQ2xFLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUNwRSxPQUFPLEtBQUssQ0FBQTtJQUNkLENBQUM7SUFDRCxPQUFPLHFCQUFNLENBQUMsZUFBZSxDQUMzQixNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsRUFBRSxLQUFLLENBQUMsRUFDdEMsTUFBTSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsV0FBVyxFQUFFLEVBQUUsS0FBSyxDQUFDLENB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