import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./styles.css";

// The macOS window is transparent so the system can draw the sidebar material.
if (/Mac/i.test(navigator.userAgent)) {
    document.documentElement.classList.add("mac");
}

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
