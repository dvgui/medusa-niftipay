"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = require("@medusajs/framework/http");
const constants_1 = require("../constants");
exports.default = (0, http_1.defineMiddlewares)({
    routes: [
        {
            matcher: constants_1.NIFTIPAY_WEBHOOK_PATH,
            methods: ["POST"],
            bodyParser: { preserveRawBody: true },
        },
    ],
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWlkZGxld2FyZXMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvYXBpL21pZGRsZXdhcmVzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsbURBQTREO0FBRTVELDRDQUFvRDtBQUVwRCxrQkFBZSxJQUFBLHdCQUFpQixFQUFDO0lBQy9CLE1BQU0sRUFBRTtRQUNOO1lBQ0UsT0FBTyxFQUFFLGlDQUFxQjtZQUM5QixPQUFPLEVBQUUsQ0FBQyxNQUFNLENBQUM7WUFDakIsVUFBVSxFQUFFLEVBQUUsZUFBZSxFQUFFLElBQUksRUFBRTtTQUN0QztLQUNGO0NBQ0YsQ0FBQyxDQUFBIn0=