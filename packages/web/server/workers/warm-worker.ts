import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { tokenMatches } from "./identity.js";

const warmAssignmentSchema = z.object({
  attemptId: z.string().min(1).max(200), conversationId: z.string().min(1).max(200),
  storeId: z.string().min(1).max(200), configurationRevision: z.string().min(1).max(200),
  token: z.string().min(43).max(256),
}).strict();

/** No store or conversation is opened until the launcher binds this process once. */
export async function awaitWarmAssignment(): Promise<void> {
  if (process.env.DISPATCH_WORKER_WARM !== "1") return;
  const token = z.string().min(43).parse(process.env.DISPATCH_WORKER_TOKEN);
  const warmId = z.string().min(1).parse(process.env.DISPATCH_WORKER_ATTEMPT_ID);
  let assignment: z.infer<typeof warmAssignmentSchema> | undefined;
  let assigned!: () => void;
  const pending = new Promise<void>(resolve => { assigned = resolve; });
  const app = new Hono();
  app.onError((_error, c) => c.json({ error: "Invalid warm assignment" }, 400));
  app.use("*", async (c, next) => {
    if (c.req.header("Origin") || !tokenMatches(token, c.req.header("Authorization"))) return c.json({ error: "Unauthorized" }, 401);
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 4096 }));
  app.get("/warm", c => c.json({ warmId, available: assignment === undefined }));
  app.post("/assign", async c => {
    const input = warmAssignmentSchema.parse(await c.req.json());
    if (input.configurationRevision !== process.env.DISPATCH_WORKER_CONFIGURATION_REVISION) return c.json({ error: "Configuration mismatch" }, 409);
    if (assignment && JSON.stringify(assignment) !== JSON.stringify(input)) return c.json({ error: "Already assigned" }, 409);
    assignment = input;
    assigned();
    return c.json({ warmId, attemptId: input.attemptId });
  });
  const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 8831 });
  await pending;
  // Closing joins the assignment response before the conversation listener takes over.
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  process.env.DISPATCH_WORKER_ATTEMPT_ID = assignment!.attemptId;
  process.env.DISPATCH_CONVERSATION_ID = assignment!.conversationId;
  process.env.DISPATCH_POSTGRES_STORE_ID = assignment!.storeId;
  process.env.DISPATCH_WORKER_TOKEN = assignment!.token;
  delete process.env.DISPATCH_WORKER_WARM;
}
