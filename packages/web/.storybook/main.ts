import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";

const config: StorybookConfig = {
  stories: ["../src/workshop/**/*.stories.tsx"],
  staticDirs: ["../public"],
  addons: ["@storybook/addon-docs"],
  framework: {
    name: "@storybook/react-vite",
    options: { builder: { viteConfigPath: ".storybook/vite.config.ts" } },
  },
  core: { disableTelemetry: true },
  async viteFinal(config) {
    // Storybook has its own HTML entry; React Router's app-entry plugin does not belong here.
    config.plugins = [...(config.plugins ?? []), tailwindcss()];
    config.define = {
      ...config.define,
      "import.meta.env.VITE_APP_VERSION": JSON.stringify("workshop"),
    };
    return config;
  },
};

export default config;
