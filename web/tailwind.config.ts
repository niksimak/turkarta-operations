import type { Config } from "tailwindcss";

// Every colour is a CSS variable from src/styles/tokens.css, so one class works
// in both themes. Do not add raw hex values here.
const v = (name: string) => `var(--${name})`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",
      bg: v("bg"),
      surface: v("surface"),
      "surface-2": v("surface-2"),
      border: v("border"),
      "border-strong": v("border-strong"),
      text: v("text"),
      "text-muted": v("text-muted"),
      accent: v("accent"),
      "accent-hover": v("accent-hover"),
      "accent-fg": v("accent-fg"),
      "accent-soft": v("accent-soft"),
      hover: v("hover"),
      pressed: v("pressed"),
      "sla-ok": v("sla-ok"),
      "sla-warn": v("sla-warn"),
      "sla-late": v("sla-late"),
      "sla-ok-soft": v("sla-ok-soft"),
      "sla-warn-soft": v("sla-warn-soft"),
      "sla-late-soft": v("sla-late-soft"),
      "note-bg": v("note-bg"),
      "note-border": v("note-border"),
      "note-text": v("note-text"),
      danger: v("danger"),
      "danger-soft": v("danger-soft"),
      "ch-bot": v("ch-bot"),
      "ch-miniapp": v("ch-miniapp"),
      "ch-web": v("ch-web"),
    },
    fontFamily: {
      sans: v("font-sans"),
      mono: v("font-mono"),
    },
    // Fixed rem scale, ratio ~1.14. [size, line-height]
    fontSize: {
      xs: ["0.75rem", "1rem"],
      sm: ["0.8125rem", "1.125rem"],
      base: ["0.875rem", "1.25rem"],
      md: ["0.9375rem", "1.375rem"],
      lg: ["1.0625rem", "1.5rem"],
      xl: ["1.25rem", "1.75rem"],
    },
    fontWeight: {
      normal: "400",
      semibold: "600",
    },
    borderRadius: {
      none: "0",
      xs: v("radius-xs"),
      sm: v("radius-sm"),
      md: v("radius-md"),
      lg: v("radius-lg"),
      full: "9999px",
    },
    extend: {
      boxShadow: {
        pop: v("shadow-pop"),
        none: "none",
      },
      transitionTimingFunction: {
        out: v("ease-out"),
        "in-out": v("ease-in-out"),
        drawer: v("ease-drawer"),
      },
      transitionDuration: {
        press: v("dur-press"),
        fast: v("dur-fast"),
        base: v("dur-base"),
        slow: v("dur-slow"),
      },
      width: { rail: "13.5rem", "rail-compact": "3.5rem" },
    },
  },
  plugins: [],
} satisfies Config;
