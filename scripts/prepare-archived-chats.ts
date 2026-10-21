import { readFile } from "node:fs/promises";
import { prepareNativeChatTransfer } from "../packages/web/server/storage/native-chat-transfer.js";
const [source, inspection, config, output, ...extra] = process.argv.slice(2);
if (!source || !inspection || !config || !output || extra.length) {
  console.error("Usage: npx tsx scripts/prepare-archived-chats.ts SOURCE_DIRECTORY TARGET_INSPECTION.json CONFIG.json NEW_OUTPUT_DIRECTORY"); process.exitCode = 2;
} else {
  try {
    console.log(JSON.stringify(await prepareNativeChatTransfer(source, JSON.parse(await readFile(inspection, "utf8")), JSON.parse(await readFile(config, "utf8")), output,
      value => console.log(JSON.stringify(value)))));
  } catch (error) { console.error(error instanceof Error ? error.message : "Preparation failed"); process.exitCode = 1; }
}
