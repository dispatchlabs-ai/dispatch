import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  define: { "import.meta.env.VITE_APP_VERSION": JSON.stringify(version) },
  plugins: [tailwindcss(), reactRouter()],
  worker: { format: "es" },
  server: {
    host: "localhost", port: Number(process.env.DISPATCH_WEB_PORT ?? 5173), strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.DISPATCH_PORT ?? 3001}` } },
  },
  preview: { host: "localhost", port: 4173, strictPort: true },
});
