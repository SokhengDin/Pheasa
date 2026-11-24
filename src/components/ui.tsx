import type { ButtonHTMLAttributes, ComponentType, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/**
 * Shared building blocks, styled with Tailwind utilities only. Theme colours
 * come from the tokens in styles.css (bg-surface, text-muted, ...), so light
 * and dark need no `dark:` variants.
 */

/** Joins class names, skipping empty ones. */
export function cx(...parts: (string | false | null | undefined)[]): string {
    return parts.filter(Boolean).join(" ");
}

/** Floating glass for toolbar controls. */
export const GLASS = "bg-glass backdrop-blur-xl backdrop-saturate-180 shadow-lift inset-shadow-specular";

/** Thicker glass for panes, menus and popovers. Add `rim` with a positioned element. */
export const GLASS_STRONG = "bg-glass-strong backdrop-blur-3xl backdrop-saturate-200 shadow-float inset-shadow-specular";

/** Cards and rows. */
export const SURFACE = "bg-surface backdrop-blur-xl backdrop-saturate-180 shadow-soft inset-shadow-specular";

/** Small grey well, for inputs and quiet buttons. */
export const WELL = "bg-fill hover:bg-fill-hover";

/** Accent-tinted selection, as on the active sidebar item or chip. */
export const TINT = "bg-accent/15 text-accent shadow-[inset_0_0_0_.5px_color-mix(in_srgb,var(--accent)_24%,transparent)]";

const PRIMARY_FILL = "bg-[linear-gradient(180deg,rgba(255,255,255,.26),transparent_50%),linear-gradient(180deg,var(--accent-2),var(--accent))]";
const DANGER_FILL  = "bg-[linear-gradient(180deg,rgba(255,255,255,.24),transparent_50%),linear-gradient(180deg,color-mix(in_srgb,var(--bad)_75%,#fff),var(--bad))]";

/** Prominent accent fill, for anything that is not a Button (steps, palette item). */
export const ACCENT_FILL = `${PRIMARY_FILL} text-white shadow-glow inset-shadow-lit`;

type ButtonVariant = "default" | "primary" | "danger" | "glass" | "plain";
type ButtonSize    = "sm" | "md" | "lg" | "xl";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
    default : "bg-fill enabled:hover:bg-fill-hover",
    glass   : `${GLASS} enabled:hover:bg-surface-hi`,
    plain   : "bg-transparent text-muted enabled:hover:bg-fill-hover enabled:hover:text-fg",
    primary : `${PRIMARY_FILL} text-white shadow-glow inset-shadow-lit enabled:hover:brightness-107 enabled:hover:saturate-110 disabled:shadow-none`,
    danger  : `${DANGER_FILL} text-white shadow-glow-bad inset-shadow-lit enabled:hover:brightness-107`,
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
    sm : "h-7 px-3 gap-1.5",
    md : "h-8 px-3.5 gap-1.5",
    lg : "h-[38px] px-[22px] gap-2 text-lead",
    xl : "h-11 min-w-32 px-[26px] gap-2 text-lead font-semibold justify-center",
};

/** Class string for a capsule button, for elements that cannot use <Button>. */
export function buttonClass(variant: ButtonVariant = "default", size: ButtonSize = "sm"): string {
    return cx(
        "relative inline-flex shrink-0 items-center whitespace-nowrap rounded-full border-0 font-medium",
        "transition-[background,box-shadow,transform,filter] duration-250 ease-spring",
        "enabled:active:scale-95 disabled:opacity-40",
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
    );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant? : ButtonVariant;
    size?    : ButtonSize;
}

export function Button({ variant = "default", size = "sm", className, type = "button", ...rest }: ButtonProps) {
    return <button type={type} className={cx(buttonClass(variant, size), className)} {...rest} />;
}

type IconSize = "sm" | "md" | "lg";

const ICON_SIZE: Record<IconSize, string> = { sm: "size-7", md: "size-8", lg: "size-10" };

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    size?   : IconSize;
    /** Pressed / on state: accent tint. */
    active? : boolean;
    glass?  : boolean;
}

export function IconButton({ size = "sm", active, glass, className, type = "button", ...rest }: IconButtonProps) {
    return (
        <button
            type={type}
            className={cx(
                "inline-flex shrink-0 items-center justify-center rounded-full border-0 p-0",
                "transition-[background,color,transform] duration-250 ease-bounce",
                "enabled:active:scale-[.88] disabled:opacity-35",
                ICON_SIZE[size],
                active ? TINT : glass ? `${GLASS} text-muted enabled:hover:text-fg` : "bg-transparent text-muted enabled:hover:bg-fill-hover enabled:hover:text-fg",
                className,
            )}
            {...rest}
        />
    );
}

const FIELD_BASE = cx(
    "h-7 rounded-ctl border-0 bg-fill px-2.5 outline-none shadow-[inset_0_0_0_.5px_var(--stroke)]",
    "transition-[background,box-shadow] duration-250 ease-spring hover:bg-fill-hover",
    "focus-visible:shadow-[0_0_0_3.5px_color-mix(in_srgb,var(--accent)_42%,transparent)] disabled:opacity-45",
);

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
    return <select className={cx(FIELD_BASE, "pr-1.5", className)} {...rest} />;
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
    return <input className={cx(FIELD_BASE, className)} {...rest} />;
}

export function Checkbox({ className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
    return <input type="checkbox" className={cx("m-0 size-[15px] accent-accent", className)} {...rest} />;
}

export function Range({ className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
    return <input type="range" className={cx("w-full accent-accent", className)} {...rest} />;
}

interface SegmentedProps<T extends string> {
    options  : { id: T; label: ReactNode }[];
    value    : T;
    onChange : (value: T) => void;
    glass?   : boolean;
    label?   : string;
}

export function Segmented<T extends string>({ options, value, onChange, glass, label }: SegmentedProps<T>) {
    return (
        <div role="radiogroup" aria-label={label} className={cx("inline-flex gap-0.5 rounded-full p-[3px]", glass ? GLASS : "bg-fill")}>
            {options.map((option) => (
                <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={value === option.id}
                    onClick={() => onChange(option.id)}
                    className={cx(
                        "h-[26px] rounded-full border-0 px-[15px] font-medium transition-[background,color,box-shadow,transform] duration-250 ease-spring active:scale-96",
                        value === option.id ? "bg-surface-hi text-fg shadow-soft inset-shadow-specular" : "bg-transparent text-muted hover:text-fg",
                    )}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}

/** Page title and subtitle at the top of a scrolling page. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
    return (
        <div className="px-1 pt-3 pb-1">
            <h1 className="m-0 mb-1 font-display text-title font-bold tracking-[-.025em] @max-[760px]:text-[22px]">{title}</h1>
            {children ? <p className="m-0 text-muted">{children}</p> : null}
        </div>
    );
}

/** Uppercase section label. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
    return <h3 className={cx("m-0 mb-2 text-tiny font-semibold uppercase tracking-[.02em] text-muted", className)}>{children}</h3>;
}

/** Grouped glass section, like System Settings. */
export function Card({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
    return (
        <section className={cx("relative flex shrink-0 flex-col overflow-hidden rounded-card", SURFACE, className)}>
            {title ? <SectionLabel className="mb-0 px-4 pt-3.5 pb-1.5">{title}</SectionLabel> : null}
            {children}
        </section>
    );
}

interface FieldProps {
    label    : ReactNode;
    detail?  : ReactNode;
    wide?    : boolean;
    children?: ReactNode;
}

/** One row of a Card: label (and detail) on the left, control on the right. */
export function Field({ label, detail, wide, children }: FieldProps) {
    return (
        <div data-field className="flex min-h-[46px] items-center justify-between gap-4 border-separator px-4 py-2 [[data-field]+&]:border-t-[.5px] @max-[760px]:flex-wrap @max-[760px]:gap-y-2">
            <div className="flex flex-col gap-px">
                <span className="inline-flex items-center gap-1.5">{label}</span>
                {detail ? <small className="text-tiny text-muted">{detail}</small> : null}
            </div>

            <div className={cx("flex min-w-0 items-center gap-2", wide && "min-w-45 flex-[0_1_320px] *:w-full @max-[760px]:min-w-0 @max-[760px]:flex-[1_1_100%]")}>
                {children}
            </div>
        </div>
    );
}

/** Small muted text inside a Card. */
export function Hint({ children, className }: { children: ReactNode; className?: string }) {
    return <p className={cx("m-0 px-3.5 pt-2 pb-3 text-small text-muted", className)}>{children}</p>;
}

type Tone = "neutral" | "accent" | "good" | "warn" | "bad";

const CHIP_TONE: Record<Tone, string> = {
    neutral : "bg-fill text-fg",
    accent  : "bg-accent/15 text-accent",
    good    : "bg-fill text-good",
    warn    : "bg-fill text-warn",
    bad     : "bg-fill text-bad",
};

export function Chip({ tone = "neutral", className, children, title }: { tone?: Tone; className?: string; children: ReactNode; title?: string }) {
    return (
        <span title={title} className={cx("inline-flex h-6 items-center gap-[5px] rounded-full px-2.5 text-small", CHIP_TONE[tone], className)}>
            {children}
        </span>
    );
}

const BADGE_TONE: Record<Tone, string> = {
    neutral : "bg-fill",
    accent  : "bg-accent/15 text-accent",
    good    : "bg-good/15 text-good",
    warn    : "bg-warn/15 text-warn",
    bad     : "bg-bad/12 text-bad",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
    return <span className={cx("rounded-full px-2 py-px text-tiny", BADGE_TONE[tone])}>{children}</span>;
}

interface CalloutProps {
    icon     : ComponentType<{ size?: number }>;
    title    : ReactNode;
    children?: ReactNode;
    action?  : ReactNode;
    tone?    : "accent" | "warn";
    className?: string;
}

/** Tinted glass notice with an icon tile, text and an optional action. */
export function Callout({ icon: Icon, title, children, action, tone = "accent", className }: CalloutProps) {
    const warn = tone === "warn";

    return (
        <div
            className={cx(
                "relative flex shrink-0 items-center gap-3.5 rounded-card px-4 py-3.5 animate-rise",
                SURFACE,
                warn
                    ? "bg-[linear-gradient(135deg,color-mix(in_srgb,var(--warn)_15%,transparent),color-mix(in_srgb,var(--warn)_5%,transparent))]"
                    : "bg-[linear-gradient(135deg,color-mix(in_srgb,var(--accent)_14%,transparent),color-mix(in_srgb,var(--accent-2)_6%,transparent))]",
                className,
            )}
        >
            <span
                className={cx(
                    "flex shrink-0 items-center justify-center rounded-[11px] p-2 text-white inset-shadow-lit",
                    warn
                        ? "bg-[linear-gradient(180deg,color-mix(in_srgb,var(--warn)_70%,#fff),var(--warn))] shadow-[0_4px_14px_color-mix(in_srgb,var(--warn)_35%,transparent)]"
                        : `${PRIMARY_FILL} shadow-glow`,
                )}
            >
                <Icon size={20} />
            </span>

            <div className="min-w-0 flex-1">
                <strong>{title}</strong>
                {children ? <div className="text-muted">{children}</div> : null}
            </div>

            {action}
        </div>
    );
}

interface EmptyProps {
    icon     : ComponentType<{ size?: number; strokeWidth?: number }>;
    title    : ReactNode;
    children?: ReactNode;
    /** Slowly pulses the icon, for "listening" states. */
    breathe? : boolean;
    className?: string;
}

/** Centred empty state with a large glass app-icon tile. */
export function EmptyState({ icon: Icon, title, children, breathe, className }: EmptyProps) {
    return (
        <div className={cx("m-auto flex max-w-[400px] flex-col items-center gap-2.5 p-10 text-center text-muted animate-fade", className)}>
            <div
                className={cx(
                    "mb-2 flex size-[76px] items-center justify-center rounded-3xl text-white",
                    "bg-[linear-gradient(180deg,rgba(255,255,255,.34),transparent_50%),linear-gradient(160deg,var(--accent-2),var(--accent)_60%,color-mix(in_srgb,var(--accent)_70%,#1d1d6b))]",
                    "shadow-[inset_0_1px_0_rgba(255,255,255,.55),0_16px_38px_color-mix(in_srgb,var(--accent)_36%,transparent)]",
                    breathe && "animate-breathe",
                )}
            >
                <Icon size={34} strokeWidth={1.75} />
            </div>

            <strong className="font-display text-[19px] font-bold tracking-[-.015em] text-fg">{title}</strong>
            {children ? <span>{children}</span> : null}
        </div>
    );
}

/** Determinate progress bar, 0 to 1. */
export function ProgressBar({ value, className }: { value: number; className?: string }) {
    return (
        <div className={cx("mt-2 h-1.5 overflow-hidden rounded-full bg-fill-hover", className)}>
            <div
                className="h-full rounded-full bg-[linear-gradient(180deg,rgba(255,255,255,.35),transparent_60%),linear-gradient(90deg,var(--accent-2),var(--accent))] transition-[width] duration-300 ease-spring"
                style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
            />
        </div>
    );
}

/** Indeterminate bar along the bottom edge of a positioned, overflow-hidden parent. */
export function IndeterminateBar() {
    return (
        <span className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden bg-accent/15">
            <i className="absolute inset-y-0 left-0 w-[35%] rounded-full bg-[linear-gradient(90deg,transparent,var(--accent-2),var(--accent),transparent)] animate-indeterminate" />
        </span>
    );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
    return <kbd className={cx("inline-flex h-[18px] items-center rounded-md bg-fill px-1.5 font-sans text-tiny font-medium text-muted", className)}>{children}</kbd>;
}

/** Loading placeholder row. */
export function Skeleton({ className }: { className?: string }) {
    return <div className={cx("mb-2 h-[52px] rounded-row bg-[linear-gradient(90deg,var(--fill)_25%,var(--fill-hover)_50%,var(--fill)_75%)] bg-size-[200%_100%] animate-shimmer", className)} />;
}
