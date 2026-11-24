/** Three soft dots, shown where a translation has not arrived yet. */
export function TypingDots() {
    const dot = "size-1.5 rounded-full bg-current animate-dots";

    return (
        <span className="inline-flex h-[1em] items-center gap-1" role="status" aria-label="Translating">
            <i className={dot} />
            <i className={`${dot} [animation-delay:.15s]`} />
            <i className={`${dot} [animation-delay:.3s]`} />
        </span>
    );
}
