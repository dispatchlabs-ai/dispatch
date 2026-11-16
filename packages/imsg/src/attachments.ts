import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessagesRpc } from "./rpc.js";
import type { TableImage } from "./text.js";

export async function stageTable(rpc: MessagesRpc, table: TableImage) {
  const { renderTable } = await import("./table.js");
  const png = await renderTable(table);
  if (rpc.stagesFiles) {
    const { file } = await rpc.call<{ file: string }>("dispatch.attachments.put", { name: table.name, png: png.toString("base64") });
    return { file, release: () => rpc.call("dispatch.attachments.remove", { name: table.name }) };
  }
  const dir = await mkdtemp(join(tmpdir(), "dispatch-imsg-"));
  const file = join(dir, table.name);
  const release = () => rm(dir, { recursive: true, force: true });
  try { await writeFile(file, png, { mode: 0o600 }); }
  catch (error) { await release(); throw error; }
  return { file, release };
}
