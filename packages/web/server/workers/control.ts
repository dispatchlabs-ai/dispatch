import { httpTelemetry } from "../telemetry.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { LauncherError, launchRequestSchema, type WorkerLauncher } from "./launcher.js";

/** Private launcher API. Supply a dedicated random credential, never a user cookie
 * or worker credential. Network isolation remains a deployment responsibility.
 */
export function createLauncherControl(launcher: WorkerLauncher, token: string) {
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)) throw new Error("Use a dedicated random launcher control token (at least 32 bytes, base64url).");
  const expected = digest(`Bearer ${token}`);
  const app = new Hono();
  app.use("*", httpTelemetry());
  app.get("/internal/ready", c => { const ready = launcher.ready(); return c.text(ready ? "ok" : "unavailable", ready ? 200 : 503); });
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.header("Origin") || !timingSafeEqual(expected, digest(c.req.header("Authorization") ?? ""))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 8192, onError: c => c.json({ error: "Control request too large" }, 413) }));
  app.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "Invalid control request" }, 400);
    if (error instanceof LauncherError) {
      const status = error.status === 409 ? 409 : error.status === 404 ? 404 : error.status === 400 ? 400 : 503;
      return c.json({ error: status === 503 ? "Launcher unavailable; reconcile before retrying" : error.message }, status);
    }
    return c.json({ error: "Launcher unavailable; reconcile before retrying" }, 503);
  });
  const attempt = z.object({ attemptId: z.string().min(1).max(200) }).strict();
  app.get("/v1/status", async c => c.json(await launcher.status()));
  app.post("/v1/ensure", async c => c.json(await launcher.ensure(launchRequestSchema.parse(await c.req.json()))));
  app.post("/v1/reconcile", async c => c.json(await launcher.reconcile(attempt.parse(await c.req.json()).attemptId)));
  app.post("/v1/stop", async c => c.json(await launcher.stop(attempt.parse(await c.req.json()).attemptId)));
  app.post("/v1/drain", async c => { await launcher.drain(); return c.json(await launcher.status()); });
  app.post("/v1/undrain", async c => { await launcher.undrain(); return c.json(await launcher.status()); });
  return app;
}

function digest(value: string) { return createHash("sha256").update(value).digest(); }
