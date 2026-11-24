import { useState } from "react";
import { Check, Copy, FileDown, X } from "lucide-react";

import { api, errorText } from "../lib/api";
import { buildExport, FORMATS, suggestedName } from "../lib/exporter";
import type { ExportContent, ExportFormat } from "../lib/exporter";
import type { Settings, TranscriptLine } from "../lib/types";
import { languageName } from "../lib/types";
import { Button, cx, GLASS_STRONG, IconButton, Select } from "./ui";

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
        <div className="relative">
            <IconButton size="lg" disabled={finals === 0} onClick={() => setOpen((v) => !v)} title="Export the transcript as a script or subtitles">
                <FileDown size={16} />
            </IconButton>

            {open ? (
                <div className={cx("absolute right-0 bottom-[calc(100%+16px)] z-20 flex w-[300px] origin-bottom-right flex-col gap-3 rounded-pane p-4 animate-pop-up rim", GLASS_STRONG)}>
                    <div className="flex items-center justify-between">
                        <strong>Export transcript</strong>
                        <IconButton onClick={() => setOpen(false)}><X size={14} /></IconButton>
                    </div>

                    <label className="flex flex-col gap-1 text-small text-muted">
                        Format
                        <Select className="w-full" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
                            {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                        </Select>
                    </label>

                    <p className="m-0 text-small text-muted">{FORMATS.find((f) => f.id === format)?.hint}</p>

                    <label className="flex flex-col gap-1 text-small text-muted">
                        Text
                        <Select className="w-full" value={content} onChange={(e) => setContent(e.target.value as ExportContent)}>
                            <option value="both">Translation and original</option>
                            <option value="translation">Translation only</option>
                            <option value="original">Original only</option>
                        </Select>
                    </label>

                    <div className="flex gap-2">
                        <Button variant="primary" onClick={save}>
                            <FileDown size={16} />
                            <span>Save as</span>
                        </Button>

                        <Button onClick={copy}>
                            <Copy size={16} />
                            <span>Copy</span>
                        </Button>
                    </div>

                    {message ? (
                        <div className="flex items-center gap-1.5 break-all text-small text-good">
                            <Check size={12} className="shrink-0" />
                            <span>{message}</span>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
