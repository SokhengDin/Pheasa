import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CircleCheck, Cpu, FolderOpen, HardDrive, Loader, Trash2, TriangleAlert } from "lucide-react";

import { api, errorText, formatBytes } from "../lib/api";
import { IS_MAC } from "../lib/prefs";
import type { RuntimeLog, Settings, StorageReport } from "../lib/types";

interface Props {
    settings : Settings;
    onChange : (settings: Settings) => void;
}

// A Mac has one build of PyTorch, and it uses the Apple GPU (Metal) on its own.
// Choosing CPU or GPU for a model happens in Settings, not here.
const FLAVORS = IS_MAC
    ? [
        { id: "auto", label: "Apple silicon and Intel Mac", hint: "Uses the Apple GPU (Metal) when the Mac has one" },
    ]
    : [
        { id: "auto", label: "Automatic",          hint: "Installs what suits this computer" },
        { id: "cpu",  label: "CPU only (smaller)", hint: "Works everywhere, a much smaller download" },
        { id: "cuda", label: "NVIDIA GPU (CUDA)",  hint: "Much larger download, needs an NVIDIA driver" },
    ];

export function StorageView({ settings, onChange }: Props) {
    const [report, setReport]     = useState<StorageReport | null>(null);
    const [flavor, setFlavor]     = useState("auto");
    const [busy, setBusy]         = useState<"setup" | "remove" | "mlx" | null>(null);
    const [log, setLog]           = useState<string[]>([]);
    const [error, setError]       = useState<string | null>(null);
    const [confirm, setConfirm]   = useState<string | null>(null);
    const logEnd                  = useRef<HTMLDivElement>(null);

    const refresh = useCallback(() => api.storageReport().then(setReport).catch(() => undefined), []);

    useEffect(() => {
        refresh();

        const unlisten = Promise.all([
            listen<RuntimeLog>("runtime-setup", (event) => {
                const { line, done, error: failure } = event.payload;

                if (line) setLog((prev) => [...prev.slice(-400), line]);
                if (done && failure) setError(failure);
                if (done) refresh();
            }),
            listen("model-download", () => refresh()),
        ]);

        return () => {
            unlisten.then((fns) => fns.forEach((fn) => fn()));
        };
    }, [refresh]);

    useEffect(() => {
        logEnd.current?.scrollIntoView({ block: "end" });
    }, [log]);

    const run = async (kind: "setup" | "remove" | "mlx") => {
        setBusy(kind);
        setError(null);
        setConfirm(null);

        if (kind !== "remove") setLog([]);

        try {
            if (kind === "setup")  await api.setupRuntime(flavor);
            if (kind === "mlx")    await api.addMlxRuntime();
            if (kind === "remove") await api.removeRuntime();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(null);
            refresh();
        }
    };

    const deleteModel = async (id: string, task: Parameters<typeof api.deleteModel>[1]) => {
        setError(null);
        setConfirm(null);

        try {
            onChange(await api.deleteModel(id, task));
        } catch (err) {
            setError(errorText(err));
        }

        refresh();
    };

    const clearSessions = async () => {
        setConfirm(null);
        await api.clearSessions().catch((err) => setError(errorText(err)));
        refresh();
    };

    if (!report) return <div className="empty">Loading</div>;

    const rt = report.runtime;

    // Two-step delete: the first click arms the button, the second one deletes.
    const armed = (key: string) => confirm === key;
    const arm   = (key: string) => setConfirm(key);

    return (
        <div className="view scroll">
            <div>
                <h1 className="page-title">Storage</h1>
                <p className="page-sub">
                    Everything the app keeps lives in one folder. Deleting an item removes all of its files.
                </p>
            </div>

            {error ? (
                <div className="status error">
                    <TriangleAlert size={14} />
                    <span>{error}</span>
                </div>
            ) : null}

            <section className="card">
                <h3>Overview</h3>

                <div className="field">
                    <div className="field-label"><span>Total used</span><small>{report.path}</small></div>
                    <div className="field-control">
                        <strong>{formatBytes(report.total_bytes)}</strong>

                        <button className="btn" onClick={() => api.revealDataDir().catch((err) => setError(errorText(err)))} title="Open the folder that holds every model and the Python runtime">
                            <FolderOpen size={16} />
                            <span>{IS_MAC ? "Show in Finder" : "Open folder"}</span>
                        </button>
                    </div>
                </div>

                <div className="field">
                    <div className="field-label"><span>Models</span></div>
                    <div className="field-control">{formatBytes(report.models_bytes)}</div>
                </div>

                <div className="field">
                    <div className="field-label"><span>Python runtime</span></div>
                    <div className="field-control">{formatBytes(rt.size_bytes)}</div>
                </div>

                <div className="field">
                    <div className="field-label"><span>Saved conversations</span></div>
                    <div className="field-control">{formatBytes(report.sessions_bytes)}</div>
                </div>
            </section>

            <section className="card">
                <h3>Python runtime</h3>

                <p className="hint">
                    Runs every model the built-in engine cannot: NLLB, M2M100, other speech models,
                    voices, speaker models, and the neural voice detector. It is a private environment inside
                    the app folder. Nothing is installed system-wide, and removing it deletes all of it.
                </p>

                {rt.python_version === null ? (
                    <div className="callout warn">
                        <TriangleAlert size={20} />
                        <div className="grow">
                            <strong>No Python found</strong>
                            <div className="muted">Install Python 3.9 or newer, then reopen the app.</div>
                        </div>
                    </div>
                ) : null}

                {rt.ready ? (
                    <>
                    <div className="field">
                        <div className="field-label">
                            <span><CircleCheck size={14} className="ok" /> Ready</span>
                            <small>Python {rt.python_version} / {rt.flavor ?? "auto"} / {formatBytes(rt.size_bytes)}</small>
                        </div>
                        <div className="field-control">
                            {armed("runtime") ? (
                                <button className="btn danger" disabled={busy !== null} onClick={() => run("remove")}>
                                    <Trash2 size={16} /><span>Confirm removal</span>
                                </button>
                            ) : (
                                <button className="btn" disabled={busy !== null} onClick={() => arm("runtime")}>
                                    <Trash2 size={16} /><span>Remove runtime</span>
                                </button>
                            )}
                        </div>
                    </div>

                    {rt.mlx_supported ? (
                        <div className="field">
                            <div className="field-label">
                                <span>
                                    {rt.mlx ? <CircleCheck size={14} className="ok" /> : <Cpu size={14} />} Apple GPU (MLX)
                                </span>
                                <small>
                                    {rt.mlx
                                        ? "Installed. MLX models run on the Apple GPU"
                                        : "Runs Whisper, Parakeet, translation models and voices on the Apple GPU"}
                                </small>
                            </div>
                            <div className="field-control">
                                {rt.mlx ? null : (
                                    <button className="btn primary" disabled={busy !== null} onClick={() => run("mlx")}>
                                        {busy === "mlx" ? <Loader size={16} className="spin" /> : <Cpu size={16} />}
                                        <span>{busy === "mlx" ? "Installing" : "Add MLX"}</span>
                                    </button>
                                )}
                            </div>
                        </div>
                    ) : null}
                    </>
                ) : (
                    <>
                        <div className="field">
                            <div className="field-label">
                                <span>Version</span>
                                <small>{FLAVORS.find((f) => f.id === flavor)?.hint}</small>
                            </div>
                            <div className="field-control wide">
                                <select value={flavor} disabled={busy !== null} onChange={(e) => setFlavor(e.target.value)}>
                                    {FLAVORS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                                </select>
                            </div>
                        </div>

                        <div className="field">
                            <div className="field-label">
                                <span>{rt.removal_queued ? "Removal pending" : "Not installed"}</span>
                                <small>
                                    {rt.removal_queued
                                        ? "Files are in use and will be deleted the next time the app starts"
                                        : "If setup fails or is interrupted, everything it created is deleted"}
                                </small>
                            </div>
                            <div className="field-control">
                                <button
                                    className="btn primary"
                                    disabled={busy !== null || rt.python_version === null || rt.removal_queued}
                                    onClick={() => run("setup")}
                                >
                                    {busy === "setup" ? <Loader size={16} className="spin" /> : <Cpu size={16} />}
                                    <span>{busy === "setup" ? "Installing" : "Set up"}</span>
                                </button>
                            </div>
                        </div>
                    </>
                )}

                {log.length > 0 ? (
                    <div className="log">
                        {log.join("\n")}
                        <div ref={logEnd} />
                    </div>
                ) : null}
            </section>

            <section className="card">
                <h3>Models</h3>

                {report.models.length === 0 ? <p className="hint">No models downloaded.</p> : null}

                {report.models.map((m) => {
                    const key = `model:${m.id}`;

                    return (
                        <div key={key} className="row">
                            <HardDrive size={16} />
                            <div className="grow">
                                <div className="name">{m.id}</div>
                                <div className="meta">
                                    <span>{m.task}</span>
                                    <span>{m.backend === "native" ? "Built-in" : m.backend === "mlx" ? "Apple GPU (MLX)" : "Python"}</span>
                                    <span>{formatBytes(m.size_bytes)}</span>
                                </div>
                            </div>

                            {armed(key) ? (
                                <button className="btn danger" onClick={() => deleteModel(m.id, m.task)}>
                                    <Trash2 size={16} /><span>Confirm</span>
                                </button>
                            ) : (
                                <button className="icon-btn" onClick={() => arm(key)} title="Delete every file of this model">
                                    <Trash2 size={16} />
                                </button>
                            )}
                        </div>
                    );
                })}

                {settings.stt_model === null && report.models.length > 0 ? (
                    <p className="hint">Models in use are cleared from Settings when deleted.</p>
                ) : null}
            </section>

            <section className="card">
                <h3>Saved conversations</h3>

                <div className="field">
                    <div className="field-label">
                        <span><FolderOpen size={14} /> History</span>
                        <small>{formatBytes(report.sessions_bytes)}</small>
                    </div>
                    <div className="field-control">
                        {armed("sessions") ? (
                            <button className="btn danger" onClick={clearSessions}>
                                <Trash2 size={16} /><span>Confirm</span>
                            </button>
                        ) : (
                            <button className="btn" disabled={report.sessions_bytes === 0} onClick={() => arm("sessions")}>
                                <Trash2 size={16} /><span>Delete all</span>
                            </button>
                        )}
                    </div>
                </div>
            </section>
        </div>
    );
}
