import type { MantineThemeOverride } from "@mantine/core";

/**
 * Terminal-inspired theme for Conductor UI.
 * - Monospace stack throughout (this is a process/log tool — lean into it)
 * - Sharp, near-zero corners
 * - WCAG AA contrast compliance (4.5:1 for normal text, 3:1 for large text)
 * - Phosphor-green primary, amber/red status accents
 */
const MONO_STACK =
  'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, "Liberation Mono", monospace';
const HAIRLINE_BORDER = "1px solid var(--mantine-color-dark-5)";

export const conductorTheme: MantineThemeOverride = {
  primaryColor: "green",
  primaryShade: { light: 6, dark: 5 },

  fontFamily: MONO_STACK,

  headings: {
    fontFamily: MONO_STACK,
    fontWeight: "600",
  },

  fontSizes: {
    xs: "11px",
    sm: "12px",
    md: "13px",
    lg: "15px",
    xl: "19px",
  },

  lineHeights: {
    xs: "1.4",
    sm: "1.45",
    md: "1.5",
    lg: "1.55",
    xl: "1.6",
  },

  // Increase spacing for more breathing room
  spacing: {
    xs: "8px",
    sm: "12px",
    md: "16px",
    lg: "24px",
    xl: "32px",
  },

  // Sharp, terminal-window corners instead of soft cards
  radius: {
    xs: "0px",
    sm: "0px",
    md: "2px",
    lg: "3px",
    xl: "5px",
  },
  // Applies to every radius-aware component below unless it sets its own
  // `defaultProps.radius` (Badge and Tooltip do, to "sm").
  defaultRadius: "md",

  shadows: {
    xs: "0 1px 2px rgba(0, 0, 0, 0.3)",
    sm: "0 2px 4px rgba(0, 0, 0, 0.35)",
    md: "0 4px 8px rgba(0, 0, 0, 0.4)",
    lg: "0 8px 16px rgba(0, 0, 0, 0.45)",
    xl: "0 16px 24px rgba(0, 0, 0, 0.5)",
  },

  // NOTE for future edits: this app has no @mantine/emotion resolver, so a
  // component's `styles` prop below only ever produces a literal inline
  // `style` attribute on the DOM node — nested selectors like "&:hover" or
  // "&[data-active]" silently no-op (only a console warning, easy to miss).
  // Anything state-dependent (hover/focus/active/data-attribute) belongs in
  // global.css as real CSS targeting Mantine's stable `mantine-<Component>-
  // <part>` class names instead — see the comment block there.
  components: {
    Card: {
      defaultProps: {
        p: "md",
        shadow: "none",
      },
      styles: {
        root: {
          borderColor: "var(--mantine-color-dark-5)",
          borderWidth: 1,
          transition: "border-color 200ms ease",
        },
      },
    },
    Button: {
      styles: {
        root: {
          fontWeight: 500,
          transition: "all 200ms ease",
        },
      },
    },
    Badge: {
      defaultProps: {
        radius: "sm",
        size: "sm",
      },
      styles: {
        root: {
          fontWeight: 500,
          fontSize: "11px",
          textTransform: "none",
          letterSpacing: 0,
          padding: "2px 8px",
        },
      },
    },
    Input: {
      styles: {
        input: {
          borderColor: "var(--mantine-color-dark-4)",
          backgroundColor: "var(--mantine-color-dark-9)",
          transition: "border-color 200ms ease, background-color 200ms ease",
        },
      },
    },
    ActionIcon: {
      styles: {
        root: {
          transition: "all 200ms ease",
        },
      },
    },
    Table: {
      defaultProps: {
        verticalSpacing: 6,
        horizontalSpacing: "sm",
      },
      styles: {
        table: {
          fontSize: "13px",
        },
        th: {
          borderColor: "var(--mantine-color-dark-6)",
          color: "var(--mantine-color-dark-3)",
          fontWeight: 600,
          fontSize: "11px",
          textTransform: "uppercase",
          letterSpacing: "0.03em",
        },
        td: {
          borderColor: "var(--mantine-color-dark-6)",
        },
        tr: {
          transition: "background-color 150ms ease",
        },
      },
    },
    Modal: {
      defaultProps: {
        centered: true,
        overlayProps: { backgroundOpacity: 0.7, blur: 0 },
      },
      styles: {
        content: {
          border: HAIRLINE_BORDER,
        },
        header: {
          borderBottom: "1px solid var(--mantine-color-dark-6)",
        },
      },
    },
    Menu: {
      styles: {
        dropdown: {
          border: HAIRLINE_BORDER,
        },
      },
    },
    Tooltip: {
      defaultProps: {
        radius: "sm",
      },
    },
    Notification: {
      styles: {
        root: {
          border: HAIRLINE_BORDER,
        },
      },
    },
  },

  // Terminal-inspired palette. Base: #080a08, phosphor accent: #4ade80
  colors: {
    dark: [
      "#e8f0e8", // 0 - very light text, high contrast
      "#c9d1c9", // 1 - secondary text
      "#a8b5a8", // 2 - tertiary text
      "#7d8a7d", // 3 - muted text (~5.5:1 on base bg, passes AA)
      "#3a453a", // 4 - border/subtle
      "#232923", // 5 - secondary bg
      "#1a1f1a", // 6 - hairlines / tertiary bg
      "#0f130f", // 7 - raised bg (sidebar, cards, hover)
      "#080a08", // 8 - main bg
      "#040504", // 9 - darkest
    ],
    // Phosphor green — primary accent and "healthy/running" status
    green: [
      "#eafff2",
      "#c9f9dc",
      "#a3f0c0",
      "#7de8a4",
      "#5ee08c",
      "#4ade80", // 5 - primary shade (dark scheme)
      "#34bf6a",
      "#239954",
      "#147a3f",
      "#0a5c2d",
    ],
    // Amber — "starting/queued" status
    yellow: [
      "#fff6df",
      "#ffe7ad",
      "#ffd67a",
      "#ffc44a",
      "#fbb52e",
      "#f5a623", // 5
      "#d38a15",
      "#a86c10",
      "#7d500c",
      "#523408",
    ],
    // Red — "failed/unhealthy" status
    red: [
      "#ffe3e0",
      "#ffbdb8",
      "#ff8f89",
      "#f66a63",
      "#ea544c",
      "#e5484d", // 5
      "#c93a3e",
      "#a52f32",
      "#7a2224",
      "#4d1517",
    ],
    gray: [
      "#f4f7f4",
      "#e2e8e2",
      "#c7d0c7",
      "#a8b5a8",
      "#7d8a7d",
      "#5b6a5b",
      "#454f45",
      "#323a32",
      "#232923",
      "#0f130f",
    ],
  },

  other: {
    transition: "all 200ms ease",
  },

  cursorType: "pointer",
};
