/**
 * Authentication — one shared bearer secret.
 *
 * The Conviction server presents `Authorization: Bearer <FORGE_WORKER_SECRET>`
 * on every protected call. We compare against our own copy in constant time
 * (over SHA-256 digests, so neither the value nor its length leaks through
 * timing). If we hold no secret at all we fail closed — a worker that cannot
 * authenticate anyone must not serve Forge work.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { fail } from "./http.ts";

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function extractBearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1]?.trim() ?? null) : null;
}

/**
 * Returns `null` when the request is authorized, or a ready-to-send error
 * Response when it is not. Callers do: `const denied = requireAuth(req); if
 * (denied) return denied;`
 */
export function requireAuth(req: Request): Response | null {
  const secret = config.workerSecret;
  if (!secret) {
    return fail(503, "FORGE_WORKER_SECRET is not configured on the worker.");
  }
  const presented = extractBearer(req);
  if (!presented) {
    return fail(401, "Missing or malformed Authorization header.");
  }
  const a = digest(presented);
  const b = digest(secret);
  // Digests are always 32 bytes, so timingSafeEqual's equal-length rule holds.
  if (!timingSafeEqual(a, b)) {
    return fail(401, "Invalid worker credentials.");
  }
  return null;
}
