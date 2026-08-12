/**
 * Conviction Forge Worker — entry point.
 *
 * Boots the job store off the persistent volume, then serves the contract on
 * `0.0.0.0:$PORT` (Railway injects PORT). A single top-level try/catch turns any
 * unexpected throw into JSON, so the client — which always parses the body —
 * never trips over a non-JSON error page.
 */
import { config, features } from "./config.ts";
import { fail } from "./http.ts";
import { log } from "./logging.ts";
import { store } from "./jobs/store.ts";
import { buildRouter } from "./routes.ts";

async function main() {
  await store.load();
  const router = buildRouter();

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // Give slow-but-legitimate operations (PR push, diff) room; the client caps
    // itself at 60s, so nothing here should approach this.
    idleTimeout: 120,
    async fetch(req) {
      try {
        return await router.handle(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : "internal error";
        log.error("unhandled request error", { error: message });
        return fail(500, message);
      }
    },
  });

  log.info("conviction-forge-worker listening", {
    host: server.hostname,
    port: server.port,
    version: config.version,
    repo: config.repoFullName,
    workspace: config.workspaceRoot,
    auth: features.auth,
    openRouter: features.openRouter,
    github: features.github,
  });

  if (!features.auth) {
    log.warn("FORGE_WORKER_SECRET is not set — protected endpoints will answer 503 until it is.");
  }

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    server.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("fatal boot error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
