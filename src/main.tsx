import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, loadSettings, resolveTheme } from "./settings/settings";
import "./index.css";

// Before the first render, so the app never paints a frame of the wrong theme
// (React's effects run after the browser has already shown that frame).
applyTheme(resolveTheme(loadSettings().theme));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
