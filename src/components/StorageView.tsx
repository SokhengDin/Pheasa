import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CircleCheck, Cpu, FolderOpen, HardDrive, Loader, Trash2, TriangleAlert } from "lucide-react";

import { api, errorText, formatBytes } from "../lib/api";
import { IS_MAC } from "../lib/prefs";
import { JOB_LABEL, clearRuntimeError, runRuntimeJob, useElapsed, useRuntimeJob } from "../lib/runtimeJob";
import type { Settings, StorageReport } from "../lib/types";
import { Button, Callout, Card, Field, Hint, IconButton, IndeterminateBar, PageHeader, SURFACE, Select, cx } from "./ui";

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
    const [localError, setError]  = useState<string | null>(null);
    const [confirm, setConfirm]   = useState<string | null>(null);
    const logBox                  = useRef<HTMLDivElement>(null);

    // The runtime job lives outside this page, so it survives switching pages.
    const job     = useRuntimeJob();
    const busy    = job.busy;
    const log     = job.log;
    const elapsed = useElapsed(job.started);
    const error   = localError ?? job.error;

    const refresh = useCallback(() => api.storageReport().then(setReport).catch(() => undefined), []);

    // Reload what is on disk on open, whenever a job ends, and after downloads.
    useEffect(() => {
        refresh();
    }, [refresh, job.finished]);

    useEffect(() => {
        const unlisten = listen("model-download", () => refresh());

        return () => {
            unlisten.then((fn) => fn());
        };
    }, [refresh]);

    // Follow the newest log line, also right after coming back to the page.
    useEffect(() => {
        const box = logBox.current;

        if (box) box.scrollTop = box.scrollHeight;
    }, [log, report]);

    const run = (kind: "setup" | "remove" | "mlx") => {
        setError(null);
        setConfirm(null);
        clearRuntimeError();

        void runRuntimeJob(kind, flavor);
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

    if (!report) {
        return <div className="m-auto flex max-w-[400px] flex-col items-center gap-2.5 p-10 text-center text-muted animate-fade">Loading</div>;
    }

    const rt = report.runtime;

    // Two-step delete: the first click arms the button, the second one deletes.
    const armed = (key: string) => confirm === key;
    const arm   = (key: string) => setConfirm(key);

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[22px] overflow-y-auto px-gutter pt-6 pb-12 [--col:760px] animate-fade *:shrink-0">
            <PageHeader title="Storage">
                Everything the app keeps lives in one folder. Deleting an item removes all of its files.
            </PageHeader>

            {error ? (
                <div className="flex items-center gap-2 px-5 pt-1.5 pb-2 text-small font-medium text-bad">
                    <TriangleAlert size={14} />
                    <span>{error}</span>
                </div>
            ) : null}

            <Card title="Overview">
                <Field label="Total used" detail={report.path}>
                    <strong>{formatBytes(report.total_bytes)}</strong>

                    <Button onClick={() => api.revealDataDir().catch((err) => setError(errorText(err)))} title="Open the folder that holds every model and the Python runtime">
                        <FolderOpen size={16} />
                        <span>{IS_MAC ? "Show in Finder" : "Open folder"}</span>
                    </Button>
                </Field>

                <Field label="Models">{formatBytes(report.models_bytes)}</Field>

                <Field label="Python runtime">{formatBytes(rt.size_bytes)}</Field>

                <Field label="Saved conversations">{formatBytes(report.sessions_bytes)}</Field>
            </Card>

            <Card title="Python runtime">
                <Hint>
                    Runs every model the built-in engine cannot: NLLB, M2M100, other speech models,
                    voices, speaker models, and the neural voice detector. It is a private environment inside
                    the app folder. Nothing is installed system-wide, and removing it deletes all of it.
                </Hint>

                {rt.python_version === null ? (
                    <Callout icon={TriangleAlert} tone="warn" title="No Python found" className="mx-4 my-1.5">
                        Install Python 3.9 or newer, then reopen the app.
                    </Callout>
                ) : null}

                {rt.ready ? (
                    <>
                    <Field
                        label={<><CircleCheck size={14} className="text-good" /> Ready</>}
                        detail={<>Python {rt.python_version} / {rt.flavor ?? "auto"} / {formatBytes(rt.size_bytes)}</>}
                    >
                        {armed("runtime") ? (
                            <Button variant="danger" disabled={busy !== null} onClick={() => run("remove")}>
                                <Trash2 size={16} /><span>Confirm removal</span>
                            </Button>
                        ) : (
                            <Button disabled={busy !== null} onClick={() => arm("runtime")}>
                                <Trash2 size={16} /><span>Remove runtime</span>
                            </Button>
                        )}
                    </Field>

                    {rt.mlx_supported ? (
                        <Field
                            label={<>{rt.mlx ? <CircleCheck size={14} className="text-good" /> : <Cpu size={14} />} Apple GPU (MLX)</>}
                            detail={rt.mlx
                                ? "Installed. MLX models run on the Apple GPU"
                                : "Runs Whisper, Parakeet, translation models and voices on the Apple GPU"}
                        >
                            {rt.mlx ? null : (
                                <Button variant="primary" disabled={busy !== null} onClick={() => run("mlx")}>
                                    {busy === "mlx" ? <Loader size={16} className="animate-spin" /> : <Cpu size={16} />}
                                    <span>{busy === "mlx" ? "Installing" : "Add MLX"}</span>
                                </Button>
                            )}
                        </Field>
                    ) : null}
                    </>
                ) : (
                    <>
                        <Field label="Version" detail={FLAVORS.find((f) => f.id === flavor)?.hint} wide>
                            <Select value={flavor} disabled={busy !== null} onChange={(e) => setFlavor(e.target.value)}>
                                {FLAVORS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                            </Select>
                        </Field>

                        <Field
                            label={rt.removal_queued ? "Removal pending" : "Not installed"}
                            detail={rt.removal_queued
                                ? "Files are in use and will be deleted the next time the app starts"
                                : "If setup fails or is interrupted, everything it created is deleted"}
                        >
                            <Button
                                variant="primary"
                                disabled={busy !== null || rt.python_version === null || rt.removal_queued}
                                onClick={() => run("setup")}
                            >
                                {busy === "setup" ? <Loader size={16} className="animate-spin" /> : <Cpu size={16} />}
                                <span>{busy === "setup" ? "Installing" : "Set up"}</span>
                            </Button>
                        </Field>
                    </>
                )}

                {busy ? (
                    <div
                        className="relative mx-4 mt-1 mb-3 flex items-center gap-3 overflow-hidden rounded-row bg-accent/10 px-3.5 pt-3 pb-4 shadow-[inset_0_0_0_.5px_color-mix(in_srgb,var(--accent)_22%,transparent)] animate-rise"
                        role="status"
                        aria-live="polite"
                    >
                        <Loader size={16} className="shrink-0 animate-spin text-accent" />
                        <div className="min-w-0 flex-1">
                            <strong className="block font-semibold">{JOB_LABEL[busy]}</strong>
                            <small className="block truncate text-tiny text-muted">{log[log.length - 1] ?? "Starting"}</small>
                        </div>
                        <span className="text-small text-muted tabular-nums">{elapsed}</span>
                        <IndeterminateBar />
                    </div>
                ) : null}

                {log.length > 0 ? (
                    <div
                        className="mx-4 mb-4 max-h-[200px] overflow-auto whitespace-pre-wrap rounded-ctl bg-fill px-3 py-2.5 font-mono text-[11px] leading-[1.45] select-text shadow-[inset_0_0_0_.5px_var(--stroke)]"
                        ref={logBox}
                    >
                        {log.join("\n")}
                    </div>
                ) : null}
            </Card>

            <Card title="Models">
                {report.models.length === 0 ? <Hint>No models downloaded.</Hint> : null}

                {report.models.map((m) => {
                    const key = `model:${m.id}`;

                    return (
                        <div key={key} className={cx("relative mb-2 flex items-center gap-3 rounded-row px-4 py-3 animate-rise [&+&]:mt-1.5", SURFACE)}>
                            <HardDrive size={16} />
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-medium">{m.id}</div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-2.5 text-small text-muted">
                                    <span>{m.task}</span>
                                    <span>{m.backend === "native" ? "Built-in" : m.backend === "mlx" ? "Apple GPU (MLX)" : "Python"}</span>
                                    <span>{formatBytes(m.size_bytes)}</span>
                                </div>
                            </div>

                            {armed(key) ? (
                                <Button variant="danger" onClick={() => deleteModel(m.id, m.task)}>
                                    <Trash2 size={16} /><span>Confirm</span>
                                </Button>
                            ) : (
                                <IconButton onClick={() => arm(key)} title="Delete every file of this model">
                                    <Trash2 size={16} />
                                </IconButton>
                            )}
                        </div>
                    );
                })}

                {settings.stt_model === null && report.models.length > 0 ? (
                    <Hint>Models in use are cleared from Settings when deleted.</Hint>
                ) : null}
            </Card>

            <Card title="Saved conversations">
                <Field label={<><FolderOpen size={14} /> History</>} detail={formatBytes(report.sessions_bytes)}>
                    {armed("sessions") ? (
                        <Button variant="danger" onClick={clearSessions}>
                            <Trash2 size={16} /><span>Confirm</span>
                        </Button>
                    ) : (
                        <Button disabled={report.sessions_bytes === 0} onClick={() => arm("sessions")}>
                            <Trash2 size={16} /><span>Delete all</span>
                        </Button>
                    )}
                </Field>
            </Card>
        </div>
    );
}
