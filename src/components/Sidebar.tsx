import { Boxes, Captions, HardDrive, History, Settings as SettingsIcon } from "lucide-react";

export type View = "live" | "history" | "models" | "storage" | "settings";

const ITEMS = [
    { id: "live",     label: "Live",     icon: Captions,     key: "1" },
    { id: "history",  label: "History",  icon: History,      key: "2" },
    { id: "models",   label: "Models",   icon: Boxes,        key: "3" },
    { id: "storage",  label: "Storage",  icon: HardDrive,    key: "4" },
    { id: "settings", label: "Settings", icon: SettingsIcon, key: "5" },
] as const;

const MOD = /Mac/i.test(navigator.userAgent) ? "Cmd" : "Ctrl";

interface Props {
    view     : View;
    device   : string;
    onChange : (view: View) => void;
}

export function Sidebar({ view, device, onChange }: Props) {
    return (
        <nav className="sidebar">
            <div className="titlebar" data-tauri-drag-region />

            <div className="brand" data-tauri-drag-region>
                <img src="/mark.svg" width={24} height={24} alt="" draggable={false} />
                <span>Pheasa</span>
            </div>

            <div className="nav-section">Translate</div>

            {ITEMS.map(({ id, label, icon: Icon, key }) => (
                <button
                    key={id}
                    className={`nav-item ${view === id ? "active" : ""}`}
                    aria-current={view === id ? "page" : undefined}
                    onClick={() => onChange(id)}
                >
                    <Icon size={16} strokeWidth={1.75} />
                    <span>{label}</span>
                    <span className="kbd">{MOD}+{key}</span>
                </button>
            ))}

            <div className="sidebar-foot">
                <span>Start or stop: {MOD}+Enter</span>
                {device ? <span>Running on {device}</span> : null}
            </div>
        </nav>
    );
}
