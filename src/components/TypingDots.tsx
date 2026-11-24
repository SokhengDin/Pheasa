/** Three soft dots, shown where a translation has not arrived yet. */
export function TypingDots() {
    return (
        <span className="typing" role="status" aria-label="Translating">
            <i /><i /><i />
        </span>
    );
}
