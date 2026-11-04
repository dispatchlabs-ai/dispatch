import React from "react";
import { createRoot } from "react-dom/client";
import { ProcessApp } from "./ProcessApp";
import "@fontsource-variable/inter";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ProcessApp />
  </React.StrictMode>,
);
