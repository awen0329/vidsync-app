import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../lib/utils";

// A small, styled button that's good enough until shadcn/ui is wired up.

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent disabled:bg-accent/50",
  secondary:
    "bg-elevated text-fg-strong ring-1 ring-line-strong hover:bg-hover disabled:opacity-60",
  ghost:
    "bg-transparent text-fg-soft hover:bg-hover hover:text-fg-strong",
  danger: "bg-rose-500 text-white hover:bg-rose-600 disabled:bg-rose-500/50",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { className, variant = "secondary", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed",
        variantClasses[variant],
        className,
      )}
      {...rest}
    />
  );
});
