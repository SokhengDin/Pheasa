import type { TranscriptLine } from "./types";

export type ExportFormat  = "srt" | "vtt" | "txt" | "md" | "json";
export type ExportContent = "translation" | "original" | "both";

export const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
    { id: "srt",  label: "SubRip (.srt)",    hint: "Subtitles for video players and editors" },
    { id: "vtt",  label: "WebVTT (.vtt)",    hint: "Subtitles for the web"                   },
    { id: "txt",  label: "Script (.txt)",    hint: "Readable script with speakers and times" },
    { id: "md",   label: "Markdown (.md)",   hint: "Script with the original quoted below"   },
    { id: "json", label: "JSON (.json)",     hint: "Raw data for your own tools"             },
];

export interface ExportOptions {
    format  : ExportFormat;
    content : ExportContent;
    names   : Record<string, string>;
    source  : string;
    target  : string;
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

function stamp(ms: number, comma: boolean): string {
    const hours   = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    const millis  = Math.floor(ms % 1000);

    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${comma ? "," : "."}${pad(millis, 3)}`;
}

function clock(ms: number): string {
    const total = Math.floor(ms / 1000);

    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** Final lines only, with an end time that never overlaps the next line. */
function prepare(lines: TranscriptLine[]) {
    const finals = lines.filter((l) => l.is_final && l.text.trim()).sort((a, b) => a.started_ms - b.started_ms);

    return finals.map((line, index) => {
        const next    = finals[index + 1];
        const natural = Math.max(line.ended_ms ?? 0, line.started_ms + 1200);
        const end     = next ? Math.min(natural, Math.max(next.started_ms, line.started_ms + 400)) : natural;

        return { ...line, end_ms: end };
    });
}

function body(line: TranscriptLine, content: ExportContent): string {
    const translated = line.translation ?? line.text;

    if (content === "original")    return line.text;
    if (content === "translation") return translated;

    return `${translated}\n${line.text}`;
}

export function buildExport(lines: TranscriptLine[], options: ExportOptions): string {
    const items = prepare(lines);
    const name  = (speaker: string) => options.names[speaker] || speaker;

    switch (options.format) {
        case "srt":
            return items
                .map((l, i) =>
                    `${i + 1}\n${stamp(l.started_ms, true)} --> ${stamp(l.end_ms, true)}\n${name(l.speaker)}: ${body(l, options.content)}\n`,
                )
                .join("\n");

        case "vtt":
            return (
                "WEBVTT\n\n" +
                items
                    .map((l) => `${stamp(l.started_ms, false)} --> ${stamp(l.end_ms, false)}\n<v ${name(l.speaker)}>${body(l, options.content)}\n`)
                    .join("\n")
            );

        case "txt":
            return items
                .map((l) => {
                    const text = body(l, options.content).split("\n");

                    return `[${clock(l.started_ms)}] ${name(l.speaker)}: ${text[0]}${text[1] ? `\n           (${text[1]})` : ""}`;
                })
                .join("\n\n");

        case "md": {
            const header = `# Transcript\n\n${options.source} to ${options.target}\n\n`;

            return (
                header +
                items
                    .map((l) => {
                        const text = body(l, options.content).split("\n");

                        return `**${name(l.speaker)}** (${clock(l.started_ms)})\n\n${text[0]}${text[1] ? `\n\n> ${text[1]}` : ""}`;
                    })
                    .join("\n\n")
            );
        }

        case "json":
            return JSON.stringify(
                {
                    source_lang : options.source,
                    target_lang : options.target,
                    lines       : items.map((l) => ({
                        speaker     : name(l.speaker),
                        source      : l.source,
                        start_ms    : l.started_ms,
                        end_ms      : l.end_ms,
                        text        : l.text,
                        translation : l.translation,
                    })),
                },
                null,
                2,
            );
    }
}

export function suggestedName(format: ExportFormat): string {
    const now = new Date();

    return `transcript-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.${format}`;
}
