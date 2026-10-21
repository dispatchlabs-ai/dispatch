import type { Preview } from "@storybook/react-vite";
import { UI } from "../src/components/ui";
import "../src/workshop/workshop.css";

const preview: Preview = {
  decorators: [
    (Story) => (
      <UI.TooltipProvider delay={300}>
        <Story />
      </UI.TooltipProvider>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    options: {
      storySort: {
        order: [
          "Start here",
          "Foundations",
          "Controls",
          "Prompt form",
          "Patterns",
          "Screens",
          "Experiments",
        ],
      },
    },
    controls: { expanded: true },
    viewport: {
      options: {
        desktop: {
          name: "Desktop · 1440 × 900",
          styles: { width: "1440px", height: "900px" },
          type: "desktop",
        },
        compact: {
          name: "Laptop · 1280 × 720",
          styles: { width: "1280px", height: "720px" },
          type: "desktop",
        },
        tablet: {
          name: "Tablet · 768 × 1024",
          styles: { width: "768px", height: "1024px" },
          type: "tablet",
        },
        phone: {
          name: "Phone · 390 × 844",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
  },
};

export default preview;
