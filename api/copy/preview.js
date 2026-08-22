import crypto from "node:crypto";
import { buildCopyPlan } from "../../lib/copy-engine.js";

function respond(res, status, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  return res.status(status).json(payload);
}

function bearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return String(req.headers["x-copy-admin-token"] || "").trim();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (process.env.COPY_PREVIEW_ENABLED !== "true" || !process.env.COPY_ADMIN_TOKEN) {
    return respond(res, 404, { error: "Not found" });
  }
  if (req.method !== "POST") return respond(res, 405, { error: "Method not allowed" });
  if (!safeEqual(bearerToken(req), process.env.COPY_ADMIN_TOKEN)) {
    return respond(res, 401, { error: "Unauthorized" });
  }

  try {
    const plan = buildCopyPlan(req.body || {});
    return respond(res, 200, { ...plan, generatedAt: new Date().toISOString() });
  } catch (error) {
    const clientError = error instanceof TypeError || error instanceof RangeError;
    return respond(res, clientError ? 400 : 500, {
      error: error instanceof Error ? error.message : "Copy preview failed",
    });
  }
}
