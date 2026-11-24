import { useState } from "react";
import { Check, Copy, FileDown, X } from "lucide-react";

import { api, errorText } from "../lib/api";
import { buildExport, FORMATS, suggestedName } from "../lib/exporter";
import type { ExportContent, ExportFormat } from "../lib/exporter";
import type { Settings, TranscriptLine } from "../lib/types";
import { languageName } from "../lib/types";

interface Props {
    lines    : TranscriptLine[];
    names    : Record<string, string>;
    settings : Settings;
}

export function ExportMenu({ lines, names, settings }: Props) {
    const [open, setOpen]       = useState(false);
    const [format, setFormat]   = useState<ExportFormat>("srt");
    const [content, setContent] = useState<ExportContent>("both");
    const [message, setMessage] = useState<string | null>(null);

    const finals = lines.filter((l) => l.is_final).length;

    const build = () =>
        buildExport(lines, {
            format,
            content,
            names,
            source : languageName(settings.source_lang),
            target : languageName(settings.target_lang),
        });

    const save = async () => {
        try {
            const path = await api.saveTextFile(suggestedName(format), format, build());

            setMessage(path ? `Saved to ${path}` : null);
        } catch (err) {
            setMessage(errorText(err));
        }
    };

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(build());
            setMessage("Copied to the clipboard");
        } catch (err) {
            setMessage(errorText(err));
        }
    };

    return (
        <div className="menu-wrap">
            <button className="btn" disabled={finals === 0} onClick={() => setOpen((v) => !v)} title="Export the transcript as a script or subtitles">
                <FileDown size={16} />
                <span>Export</span>
            </button>

            {open ? (
                <div className="menu">
                    <div className="menu-head">
                        <strong>Export transcript</strong>
                        <button className="icon-btn" onClick={() => setOpen(false)}><X size={14} /></button>
                    </div>

                    <label>
                        Format
                        <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
                            {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                        </select>
                    </label>

                    <p className="hint">{FORMATS.find((f) => f.id === format)?.hint}</p>

                    <label>
                        Text
                        <select value={content} onChange={(e) => setContent(e.target.value as ExportContent)}>
                            <option value="both">Translation and original</option>
                            <option value="translation">Translation only</option>
                            <option value="original">Original only</option>
                        </select>
                    </label>

                    <div className="menu-actions">
                        <button className="btn primary" onClick={save}>
                            <FileDown size={16} />
                            <span>Save as</span>
                        </button>

                        <button className="btn" onClick={copy}>
                            <Copy size={16} />
                            <span>Copy</span>
                        </button>
                    </div>

                    {message ? (
                        <div className="hint done">
                            <Check size={12} />
                            <span>{message}</span>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
