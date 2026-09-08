"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyNiftipayWebhook = exports.verifyNiftipayWebhookDetailed = exports.signNiftipayWebhook = void 0;
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
const verifyNiftipayWebhookDetailed = ({ rawBody, headers, data, options, }) => {
    const timestamp = headerValue(headers, "x-timestamp");
    const signature = headerValue(headers, "x-signature");
    if (timestamp || signature) {
        if (!timestamp ||
            !signature?.startsWith("v1=") ||
            !/^\d{9,12}$/.test(timestamp)) {
            return { ok: false, reason: "malformed_signature_headers" };
        }
        const timestampSeconds = Number(timestamp);
        const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
        const skew = Math.abs(nowSeconds - timestampSeconds);
        if (!Number.isFinite(timestampSeconds) || skew > options.toleranceSeconds) {
            return {
                ok: false,
                reason: "timestamp_outside_tolerance",
                // A retry of an older delivery lands here; the skew says how stale.
                detail: `skew=${skew}s tolerance=${options.toleranceSeconds}s`,
            };
        }
        return timingSafeHexEqual(signature.slice(3), (0, exports.signNiftipayWebhook)(timestamp, rawBody, options.secret))
            ? { ok: true }
            : { ok: false, reason: "signature_mismatch" };
    }
    if (!options.allowLegacy) {
        return { ok: false, reason: "unsigned_and_legacy_disabled" };
    }
    const headerSecret = headerValue(headers, "x-webhook-secret");
    const bodySecret = (0, utils_1.isRecord)(data)
        ? (0, utils_1.optionalString)(data.webhookSecret)
        : undefined;
    const supplied = headerSecret ?? bodySecret;
    if (!supplied)
        return { ok: false, reason: "legacy_secret_missing" };
    const suppliedBytes = Buffer.from(supplied, "utf8");
    const expectedBytes = Buffer.from(options.secret, "utf8");
    return suppliedBytes.length === expectedBytes.length &&
        node_crypto_1.default.timingSafeEqual(suppliedBytes, expectedBytes)
        ? { ok: true }
        : { ok: false, reason: "legacy_secret_mismatch" };
};
exports.verifyNiftipayWebhookDetailed = verifyNiftipayWebhookDetailed;
/** Boolean form, preserved for existing callers. */
const verifyNiftipayWebhook = (input) => (0, exports.verifyNiftipayWebhookDetailed)(input).ok;
exports.verifyNiftipayWebhook = verifyNiftipayWebhook;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2ViaG9vay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9saWIvbmlmdGlwYXktY2xpZW50L3dlYmhvb2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBQUEsOERBQWdDO0FBRWhDLG1DQUFrRDtBQVNsRCxNQUFNLFdBQVcsR0FBRyxDQUNsQixPQUFnQyxFQUNoQyxJQUFZLEVBQ1EsRUFBRTtJQUN0QixNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FDeEMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsV0FBVyxFQUFFLEtBQUssSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUNwRCxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUE7SUFDTixNQUFNLEtBQUssR0FBRyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQTtJQUNyRCxPQUFPLElBQUEsc0JBQWMsRUFBQyxLQUFLLENBQUMsQ0FBQTtBQUM5QixDQUFDLENBQUE7QUFFRCxNQUFNLGtCQUFrQixHQUFHLENBQUMsSUFBWSxFQUFFLEtBQWEsRUFBVyxFQUFFO0lBQ2xFLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUNwRSxPQUFPLEtBQUssQ0FBQTtJQUNkLENBQUM7SUFDRCxPQUFPLHFCQUFNLENBQUMsZUFBZSxDQUMzQixNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsRUFBRSxLQUFLLENBQUMsRUFDdEMsTUFBTSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsV0FBVyxFQUFFLEVBQUUsS0FBSyxDQUFDLENB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