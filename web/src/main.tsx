import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { paintTheme, storedThemePref } from "./lib/theme";
import { App } from "./app";
import { registerServiceWorker } from "./lib/push";

// Paint the remembered theme before the first render; Shell takes over once /me loads.
paintTheme(storedThemePref());

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

registerServiceWorker();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
