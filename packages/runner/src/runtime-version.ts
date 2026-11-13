import { createRequire } from "node:module";

export const piDurableVersion: string = (createRequire(import.meta.url)("@earendil-works/pi-durable/package.json") as { version: string }).version;
