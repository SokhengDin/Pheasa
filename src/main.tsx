import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { applyTheme, savedTheme } from "./lib/theme";
import "./styles.css";

// The macOS window is transparent so the system can draw the sidebar material.
if (/Mac/i.test(navigator.userAgent)) {
    document.documentElement.classList.add("mac");
}

// Apply the saved appearance before the first paint, so there is no flash.
applyTheme(savedTheme());

async function boot() {
    // In a plain browser during development, a small fake backend stands in for Tauri.
    if (import.meta.env.DEV) {
        const { installDevMock } = await import("./lib/devMock");
        installDevMock();
    }

    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>,
    );
}

void boot();
