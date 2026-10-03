import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  server: {
    host: "localhost", port: Number(process.env.DISPATCH_WEB_PORT ?? 5173), strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.DISPATCH_PORT ?? 3001}` } },
  },
  preview: { host: "localhost", port: 4173, strictPort: true },
});
