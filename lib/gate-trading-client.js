import crypto from "node:crypto";

const PREFIX = "/api/v4";
const DEFAULT_BASE_URLS = Object.freeze({
  live: "https://api.gateio.ws/api/v4",
  testnet: "https://api-testnet.gateapi.io/api/v4",
});

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sha512 = (value = "") => crypto.createHash("sha512").update(value).digest("hex");

function normalizeEnvironment(value) {
  const environment = String(value || "testnet").toLowerCase();
  if (!Object.hasOwn(DEFAULT_BASE_URLS, environment)) {
    throw new RangeError("Gate environment must be live or testnet");
  }
  return environment;
}

function normalizeQuery(query) {
  if (!query) return "";
  if (typeof query === "string") return query.replace(/^\?/, "");
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value == null) return;
    if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
    else params.set(key, String(value));
  });
  return params.toString();
}

export function createGateSignature({ method, path, query = "", body = "", timestamp, secret }) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const normalizedPath = path.startsWith(PREFIX) ? path : `${PREFIX}${path}`;
  const normalizedQuery = normalizeQuery(query);
  const bodyText = typeof body === "string" ? body : JSON.stringify(body ?? "");
  const signText = [normalizedMethod, normalizedPath, normalizedQuery, sha512(bodyText), String(timestamp)].join("\n");
  return crypto.createHmac("sha512", secret).update(signText).digest("hex");
}

export class GateApiError extends Error {
  constructor(message, { status = 0, label = "GATE_API_ERROR", detail = null, retryable = false } = {}) {
    super(message);
    this.name = "GateApiError";
    this.status = status;
    this.label = label;
    this.detail = detail;
    this.retryable = retryable;
  }
}

export function createGateTradingClient({
  key,
  secret,
  environment = "testnet",
  baseUrl,
  timeoutMs = 10_000,
  allowOrderPlacement = false,
  allowLiveTrading = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!key || !secret) throw new TypeError("Gate API key and secret are required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");

  const env = normalizeEnvironment(environment);
  const root = String(baseUrl || DEFAULT_BASE_URLS[env]).replace(/\/$/, "");
  const rootWithoutPrefix = root.endsWith(PREFIX) ? root.slice(0, -PREFIX.length) : root;

  async function request(method, path, { query, body, signal } = {}) {
    const normalizedMethod = String(method || "GET").toUpperCase();
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const queryText = normalizeQuery(query);
    const bodyText = body == null ? "" : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createGateSignature({
      method: normalizedMethod,
      path: normalizedPath,
      query: queryText,
      body: bodyText,
      timestamp,
      secret,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Gate API timeout")), timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    try {
      const response = await fetchImpl(
        `${rootWithoutPrefix}${PREFIX}${normalizedPath}${queryText ? `?${queryText}` : ""}`,
        {
          method: normalizedMethod,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            KEY: key,
            Timestamp: timestamp,
            SIGN: signature,
          },
          body: bodyText || undefined,
          signal: controller.signal,
          cache: "no-store",
        },
      );

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const label = payload?.label || "GATE_API_ERROR";
        const detail = payload?.detail || payload?.message || null;
        throw new GateApiError(detail || `Gate API request failed (${response.status})`, {
          status: response.status,
          label,
          detail,
          retryable: RETRYABLE_STATUS.has(response.status),
        });
      }

      return {
        data: payload,
        rateLimit: {
          remaining: response.headers.get("x-gate-ratelimit-requests-remain"),
          limit: response.headers.get("x-gate-ratelimit-limit"),
          resetAt: response.headers.get("x-gate-ratelimit-reset-timestamp"),
        },
      };
    } catch (error) {
      if (error instanceof GateApiError) throw error;
      const aborted = error?.name === "AbortError" || controller.signal.aborted;
      throw new GateApiError(aborted ? "Gate API request timed out" : "Gate API network request failed", {
        label: aborted ? "NETWORK_TIMEOUT" : "NETWORK_ERROR",
        detail: error instanceof Error ? error.message : null,
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abort);
    }
  }

  function assertOrderPlacementEnabled() {
    if (!allowOrderPlacement) {
      throw new GateApiError("Order placement is disabled for this client", {
        label: "ORDER_PLACEMENT_DISABLED",
      });
    }
    if (env === "live" && !allowLiveTrading) {
      throw new GateApiError("Live trading requires an explicit runtime enable flag", {
        label: "LIVE_TRADING_DISABLED",
      });
    }
  }

  return {
    environment: env,
    request,
    async verifyFuturesConnection(settle = "usdt") {
      return request("GET", `/futures/${settle}/accounts`);
    },
    async getFuturesPositions(settle = "usdt", query = { holding: true }) {
      return request("GET", `/futures/${settle}/positions`, { query });
    },
    async getFuturesContract(contract, settle = "usdt") {
      return request("GET", `/futures/${settle}/contracts/${encodeURIComponent(contract)}`);
    },
    async placeFuturesOrder(order, settle = "usdt") {
      assertOrderPlacementEnabled();
      if (!order?.contract || order?.size == null || order?.price == null) {
        throw new TypeError("contract, size and price are required");
      }
      if (order.text && !/^t-[0-9A-Za-z_.-]{1,28}$/.test(order.text)) {
        throw new TypeError("Gate order text must use t- prefix and at most 28 allowed bytes");
      }
      return request("POST", `/futures/${settle}/orders`, { body: order });
    },
  };
}
