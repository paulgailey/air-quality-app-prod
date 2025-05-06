var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-b5zW8f/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// dist/index.js
var t = /* @__PURE__ */ __name(({ base: e = "", routes: t2 = [], ...r2 } = {}) => ({ __proto__: new Proxy({}, { get: /* @__PURE__ */ __name((r22, o2, a, s) => (r3, ...c) => t2.push([o2.toUpperCase?.(), RegExp(`^${(s = (e + r3).replace(/\/+(\/|$)/g, "$1")).replace(/(\/?\.?):(\w+)\+/g, "($1(?<$2>*))").replace(/(\/?\.?):(\w+)/g, "($1(?<$2>[^$1/]+?))").replace(/\./g, "\\.").replace(/(\/?)\*/g, "($1.*)?")}/*$`), c, s]) && a, "get") }), routes: t2, ...r2, async fetch(e2, ...o2) {
  let a, s, c = new URL(e2.url), n = e2.query = { __proto__: null };
  for (let [e3, t3] of c.searchParams)
    n[e3] = n[e3] ? [].concat(n[e3], t3) : t3;
  e:
    try {
      for (let t3 of r2.before || [])
        if ((a = await t3(e2.proxy ?? e2, ...o2)) != null)
          break e;
      t:
        for (let [r22, n2, l, i] of t2)
          if ((r22 == e2.method || r22 == "ALL") && (s = c.pathname.match(n2))) {
            e2.params = s.groups || {}, e2.route = i;
            for (let t3 of l)
              if ((a = await t3(e2.proxy ?? e2, ...o2)) != null)
                break t;
          }
    } catch (t3) {
      if (!r2.catch)
        throw t3;
      a = await r2.catch(t3, e2.proxy ?? e2, ...o2);
    }
  try {
    for (let t3 of r2.finally || [])
      a = await t3(a, e2.proxy ?? e2, ...o2) ?? a;
  } catch (t3) {
    if (!r2.catch)
      throw t3;
    a = await r2.catch(t3, e2.proxy ?? e2, ...o2);
  }
  return a;
} }), "t");
var r = /* @__PURE__ */ __name((e = "text/plain; charset=utf-8", t2) => (r2, o2 = {}) => {
  if (r2 === void 0 || r2 instanceof Response)
    return r2;
  const a = new Response(t2?.(r2) ?? r2, o2.url ? void 0 : o2);
  return a.headers.set("content-type", e), a;
}, "r");
var o = r("application/json; charset=utf-8", JSON.stringify);
var p = r("text/plain; charset=utf-8", String);
var f = r("text/html");
var u = r("image/jpeg");
var h = r("image/png");
var g = r("image/webp");
var TpaServer = class {
  static {
    __name(this, "TpaServer");
  }
  config;
  constructor(config) {
    this.config = config;
    console.log(`TpaServer initialized for ${config.packageName}`);
  }
  async onSession(session, sessionId, userId) {
    console.log(`New session: ${sessionId} for user ${userId}`);
  }
};
var AQI_LEVELS = [
  { max: 50, label: "Good", emoji: "\u{1F60A}", advice: "Perfect for outdoor activities!" },
  { max: 100, label: "Moderate", emoji: "\u{1F610}", advice: "Acceptable air quality" },
  { max: 150, label: "Unhealthy for Sensitive Groups", emoji: "\u{1F637}", advice: "Reduce prolonged exertion" },
  { max: 200, label: "Unhealthy", emoji: "\u{1F628}", advice: "Wear a mask outdoors" },
  { max: 300, label: "Very Unhealthy", emoji: "\u26A0\uFE0F", advice: "Limit outdoor exposure" },
  { max: Infinity, label: "Hazardous", emoji: "\u2622\uFE0F", advice: "Stay indoors with windows closed" }
];
var VOICE_COMMANDS = [
  "air quality",
  "what's the air like",
  "pollution",
  "how clean is the air",
  "is the air safe",
  "nearest air quality station",
  "air quality here",
  "air pollution here"
];
var AirQualityWorker = class {
  static {
    __name(this, "AirQualityWorker");
  }
  env;
  router;
  tpaServer;
  sessionMap;
  constructor(env) {
    this.env = env;
    this.router = t();
    this.sessionMap = /* @__PURE__ */ new Map();
    this.tpaServer = new TpaServer({
      packageName: "air-quality-app",
      apiKey: env.AUGMENTOS_API_KEY
    });
    this.setupRoutes();
    this.setupTPAHooks();
  }
  setupRoutes() {
    this.router.get("/", () => this.jsonResponse({
      status: "running",
      version: "2.2.2",
      endpoints: ["/health", "/tpa_config.json", "/debug"]
    }));
    this.router.get("/health", (request) => this.jsonResponse({
      status: "healthy",
      sessions: this.sessionMap.size,
      clientIp: request.headers.get("cf-connecting-ip"),
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
    }));
    this.router.get("/tpa_config.json", () => this.jsonResponse({
      voiceCommands: VOICE_COMMANDS.map((phrase) => ({
        phrase,
        description: "Check air quality"
      })),
      permissions: ["location"],
      transcriptionLanguages: ["en-US"],
      requiresSdk: true
    }));
    this.router.post("/webhook", async (request) => {
      try {
        const data = await request.json();
        if (data.type === "session_request") {
          await this.createSession(data.sessionId, data.userId);
          return this.jsonResponse({ status: "success" });
        }
        return this.jsonResponse({ status: "invalid_request" }, 400);
      } catch (err) {
        console.error("Webhook error:", err);
        return this.jsonResponse({ status: "error" }, 500);
      }
    });
    this.router.get("/debug", () => this.jsonResponse({
      tpaServer: typeof this.tpaServer,
      sessions: Array.from(this.sessionMap.keys()),
      environment: {
        hasAqiToken: !!this.env.AQI_TOKEN,
        hasSessionsKv: !!this.env.SESSIONS
      }
    }));
    this.router.all("*", () => this.setCorsHeaders(new Response("Not Found", { status: 404 })));
  }
  setupTPAHooks() {
    this.tpaServer.onSession = async (session, sessionId, userId) => {
      this.sessionMap.set(sessionId, { userId, locationObtained: false });
      session.events.onLocation(async (coords) => {
        const sessionData = this.sessionMap.get(sessionId);
        if (sessionData) {
          sessionData.locationObtained = true;
          sessionData.lastLocation = { lat: coords.lat, lon: coords.lng };
          await this.showAirQuality(session, coords.lat, coords.lng, false);
        }
      });
      session.events.onTranscription(async (transcript) => {
        if (transcript.language === "en-US" && VOICE_COMMANDS.some((cmd) => transcript.text.toLowerCase().includes(cmd.toLowerCase()))) {
          const sessionData = this.sessionMap.get(sessionId);
          if (sessionData?.lastLocation) {
            await this.showAirQuality(session, sessionData.lastLocation.lat, sessionData.lastLocation.lon, false);
          } else {
            await this.handleAirQualityRequest(session, sessionId);
          }
        }
      });
    };
  }
  async showAirQuality(session, lat, lon, isFallback) {
    try {
      const station = await this.getNearestAQIStation(lat, lon);
      const quality = AQI_LEVELS.find((level) => station.aqi <= level.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      const message = `${isFallback ? "\u26A0\uFE0F " : "\u{1F4CD} "}${station.station.name}

Air Quality: ${quality.label} ${quality.emoji}
AQI: ${station.aqi}

${quality.advice}`;
      await session.layouts.showTextWall(message, {
        view: "main",
        durationMs: 15e3
      });
    } catch (error) {
      console.error("Air quality check failed:", error);
      await session.layouts.showTextWall("\u26A0\uFE0F Couldn't retrieve air quality data.", {
        view: "main",
        durationMs: 5e3
      });
    }
  }
  async handleAirQualityRequest(session, sessionId) {
    const sessionData = this.sessionMap.get(sessionId);
    if (!sessionData)
      return;
    if (sessionData.lastLocation) {
      return this.showAirQuality(session, sessionData.lastLocation.lat, sessionData.lastLocation.lon, false);
    }
    await this.showAirQuality(session, 51.5074, -0.1278, true);
  }
  async getNearestAQIStation(lat, lon) {
    const response = await fetch(`https://api.waqi.info/feed/geo:${lat};${lon}/?token=${this.env.AQI_TOKEN}`);
    const data = await response.json();
    if (data.status !== "ok") {
      throw new Error(data.data || "Station data unavailable");
    }
    return {
      aqi: data.aqi || 0,
      station: {
        name: data.city?.name || "Nearest AQI station",
        geo: data.city?.geo || [lat, lon]
      }
    };
  }
  async createSession(sessionId, userId) {
    await this.env.SESSIONS.put(`session#${sessionId}`, JSON.stringify({ userId, createdAt: Date.now() }), { expirationTtl: 86400 });
    this.sessionMap.set(sessionId, { userId, locationObtained: false });
  }
  setCorsHeaders(response) {
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", this.env.CF_ALLOWED_HEADERS || "");
    return new Response(response.body, { ...response, headers });
  }
  jsonResponse(data, status = 200) {
    return this.setCorsHeaders(new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" }
    }));
  }
  async handleRequest(request, ctx) {
    if (request.method === "OPTIONS") {
      return this.setCorsHeaders(new Response(null, { status: 204 }));
    }
    if (request.headers.get("Upgrade") === "websocket") {
      try {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();
        server.addEventListener("message", (event) => {
          console.log("WebSocket message:", event.data);
        });
        return new Response(null, {
          status: 101,
          webSocket: client
        });
      } catch (error) {
        console.error("WebSocket error:", error);
        return this.setCorsHeaders(new Response("WebSocket connection failed", { status: 500 }));
      }
    }
    return this.router.handle(request);
  }
};
var src_default = {
  async fetch(request, env, ctx) {
    try {
      console.log(`Request: ${request.method} ${request.url}`);
      if (!env.AUGMENTOS_API_KEY || !env.AQI_TOKEN) {
        throw new Error("Missing required environment variables");
      }
      const worker = new AirQualityWorker(env);
      const response = await worker.handleRequest(request, ctx);
      console.log(`Response: ${response.status}`);
      return response;
    } catch (error) {
      console.error("Worker error:", error);
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
        request: {
          url: request.url,
          method: request.method
        },
        stack: env.AUGMENTOS_DEBUG === "true" && error instanceof Error ? error.stack : void 0
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }
};

// ../../../../.bun/install/global/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../.bun/install/global/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-b5zW8f/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../.bun/install/global/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-b5zW8f/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
