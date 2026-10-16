import { addons } from "storybook/manager-api";
import { create } from "storybook/theming/create";

addons.setConfig({
  showPanel: false,
  theme: create({
    base: "light",
    brandTitle: "Dispatch · Component workshop",
    brandUrl: "?path=/story/start-here--overview",
    colorPrimary: "#1d3d6a",
    colorSecondary: "#267e9b",
    appBg: "#f4f8fc",
    appContentBg: "#ffffff",
    appBorderColor: "#dde6f2",
    textColor: "#10243f",
    fontBase: '"Inter Variable", Inter, sans-serif',
  }),
});
