/**
 * HTTP primitives.
 *
 * Two invariants the Conviction adapter depends on:
 *   1. Every response is valid JSON — even 401s, 404s, and 500s — because the
 *      client always calls `res.json()`. A bare 500 with an HTML body would
 *      crash the caller while parsing.
 *   2. Endpoints that conceptually return void still send a body: `{ ok: true }`.
 *
 * The router is deliberately tiny: a method + a `/a/:b/c` pattern, compiled to
 * a matcher that pulls named params out of the path. No dependency, so the
 * whole surface is auditable in one file.
 */
import { log } from "./logging.ts";

export type Ctx = {
  req: Request;
  url: URL;
  params: Record<string, string>;
  /** Parsed JSON body for POST/PUT/PATCH, or undefined. */
  body: unknown;
};

export type Handler = (ctx: Ctx) => Response | Promise<Response>;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data ?? {}), { status, headers: JSON_HEADERS });
}

/** The canonical "void, but valid JSON" response. */
export function ok(extra?: Record<string, unknown>): Response {
  return json({ ok: true, ...extra });
}

export function fail(status: number, error: string, extra?: Record<string, unknown>): Response {
  return json({ ok: false, error, ...extra }, status);
}

type Route = {
  method: string;
  keys: string[];
  regex: RegExp;
  handler: Handler;
};

function compile(pattern: string): { keys: string[]; regex: RegExp } {
  const keys: string[] = [];
  const source = pattern
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { keys, regex: new RegExp(`^${source}/?$`) };
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    const { keys, regex } = compile(pattern);
    this.routes.push({ method: method.toUpperCase(), keys, regex, handler });
    return this;
  }

  get(pattern: string, handler: Handler) {
    return this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: Handler) {
    return this.add("POST", pattern, handler);
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    let methodMismatch = false;

    for (const route of this.routes) {
      const m = route.regex.exec(path);
      if (!m) continue;
      if (route.method !== req.method) {
        methodMismatch = true;
        continue;
      }
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? "");
      });

      let body: unknown;
      if (req.method !== "GET" && req.method !== "HEAD") {
        body = await readJson(req);
      }

      try {
        return await route.handler({ req, url, params, body });
      } catch (err) {
        const message = err instanceof Error ? err.message : "internal error";
        log.error("handler threw", { path, method: req.method, error: message });
        return fail(500, message);
      }
    }

    if (methodMismatch) return fail(405, `Method ${req.method} not allowed for ${path}`);
    return fail(404, `No route for ${req.method} ${path}`);
  }
}

/** Parse a JSON body, tolerating an empty body (many POSTs carry none). */
async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return undefined;
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("json")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A malformed body becomes `undefined`; handlers validate what they need.
    return undefined;
  }
}
