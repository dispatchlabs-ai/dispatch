import { Source } from "./source";
import { connectionSchema, readRequestSchema } from "../shared/contracts";
import { redact } from "./projection";

type Port = {
  on(event: "message", listener: (event: { data: any }) => void): void;
  postMessage(value: unknown): void;
};
const port = (process as typeof process & { parentPort: Port }).parentPort;
let source: Source | undefined;
let serial = Promise.resolve();
port.on("message", ({ data }) => {
  // Source operations share one snapshot/transport lifetime, in arrival order.
  serial = serial.then(async () => {
    try {
      let result: unknown;
      if (data.operation === "probe") {
        const candidate = new Source(
          connectionSchema.parse(data.connection),
          data.password,
        );
        try {
          result = await candidate.open();
        } finally {
          await candidate.close();
        }
      } else if (data.operation === "connect") {
        await source?.close();
        source = undefined;
        const candidate = new Source(
          connectionSchema.parse(data.connection),
          data.password,
        );
        result = await candidate.open();
        source = candidate;
      } else if (data.operation === "disconnect") {
        await source?.close();
        source = undefined;
      } else if (data.operation === "read") {
        if (!source) throw new Error("Choose a connection first");
        result = await source.read(readRequestSchema.parse(data.request));
      } else throw new Error("Unknown reader operation");
      port.postMessage({ id: data.id, result });
    } catch (error) {
      port.postMessage({
        id: data.id,
        error: redact(error instanceof Error ? error.message : "Reader failed"),
      });
    }
  });
});
