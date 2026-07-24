import type { MantineThemeOverride } from "@mantine/core";

/**
 * Dark theme customization for Conductor UI.
 * Provides a modern, professional appearance inspired by GitHub and VSCode with:
 * - System font stack (no web fonts)
 * - Increased spacing and padding
 * - 8px border radius for modern cards
 * - WCAG AA contrast compliance (4.5:1 for normal text, 3:1 for large text)
 * - Subtle shadows and transitions for depth
 * - GitHub/VSCode-inspired color palette
 */
export const conductorTheme: MantineThemeOverride = {
  primaryColor: "blue",

  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',

  headings: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
    fontWeight: "600",
  },

  fontSizes: {
    xs: "11px",
    sm: "12px",
    md: "14px",
    lg: "16px",
    xl: "20px",
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

  // 8px border radius for modern cards
  radius: {
    xs: "4px",
    sm: "6px",
    md: "8px",
    lg: "12px",
    xl: "16px",
  },

  shadows: {
    xs: "0 1px 2px rgba(0, 0, 0, 0.3)",
    sm: "0 2px 4px rgba(0, 0, 0, 0.35)",
    md: "0 4px 8px rgba(0, 0, 0, 0.4)",
    lg: "0 8px 16px rgba(0, 0, 0, 0.45)",
    xl: "0 16px 24px rgba(0, 0, 0, 0.5)",
  },

  components: {
    Card: {
      defaultProps: {
        radius: "md",
        p: "md",
        shadow: "sm",
      },
      styles: {
        root: {
          borderColor: "rgba(208, 215, 222, 0.1)",
          borderWidth: 1,
          transition: "box-shadow 200ms ease, border-color 200ms ease",
          "&:hover": {
            boxShadow: "0 3px 12px rgba(0, 0, 0, 0.45)",
          },
        },
      },
    },
    Button: {
      defaultProps: {
        radius: "md",
      },
      styles: {
        root: {
          fontWeight: 500,
          transition: "all 200ms ease",
          "&:active": {
            transform: "translateY(1px)",
          },
        },
      },
    },
    Badge: {
      defaultProps: {
        radius: "md",
        size: "sm",
      },
      styles: {
        root: {
          fontWeight: 500,
          fontSize: "11px",
        },
      },
    },
    Input: {
      defaultProps: {
        radius: "md",
      },
      styles: {
        input: {
          borderColor: "rgba(208, 215, 222, 0.15)",
          backgroundColor: "rgba(13, 17, 23, 0.5)",
          transition: "border-color 200ms ease, background-color 200ms ease",
          "&:focus": {
            borderColor: "rgba(88, 166, 255, 0.5)",
            backgroundColor: "rgba(13, 17, 23, 0.8)",
          },
          "&::placeholder": {
            color: "rgba(139, 148, 155, 0.6)",
          },
        },
      },
    },
    TextInput: {
      defaultProps: {
        radius: "md",
      },
    },
    Select: {
      defaultProps: {
        radius: "md",
      },
    },
    Tabs: {
      defaultProps: {
        radius: "md",
      },
    },
    ActionIcon: {
      defaultProps: {
        radius: "md",
      },
      styles: {
        root: {
          transition: "all 200ms ease",
        },
      },
    },
  },

  // GitHub Dark-inspired color palette
  // Base: #0d1117, Secondary: #161b22, Tertiary: #21262d
  colors: {
    dark: [
      "#e6edf3", // 0 - very light text, high contrast
      "#c9d1d9", // 1 - secondary text
      "#8b949e", // 2 - tertiary text
      "#6e7681", // 3 - muted text
      "#484f58", // 4 - border/subtle
      "#30363d", // 5 - secondary bg
      "#21262d", // 6 - tertiary bg
      "#161b22", // 7 - secondary bg (used for raised elements)
      "#0d1117", // 8 - main bg
      "#010409", // 9 - darkest
    ],
    // VSCode-inspired blue for primary action
    blue: [
      "#ddf4ff",
      "#b6e3ff",
      "#80c7ff",
      "#54aeff",
      "#3898ff",
      "#1f6feb",
      "#1158ca",
      "#0860ca",
      "#033d8b",
      "#0a3069",
    ],
    // Status colors with WCAG AA compliance
    green: [
      "#d3f688",
      "#b3e635",
      "#94d82d",
      "#74c000",
      "#5c940d",
      "#4c6e1f",
      "#3c5a1f",
      "#2f4f20",
      "#234d1e",
      "#1a3a1a",
    ],
    red: [
      "#ffdcd7",
      "#ffb4af",
      "#ff7674",
      "#ff5757",
      "#f85149",
      "#da3633",
      "#b62324",
      "#8b2c2c",
      "#67060c",
      "#490202",
    ],
    yellow: [
      "#fff8c5",
      "#fff3a3",
      "#ffd960",
      "#f9c513",
      "#eac54f",
      "#d29922",
      "#a97700",
      "#845c0f",
      "#6c4410",
      "#4d2d0c",
    ],
    gray: [
      "#f6f8fa",
      "#eaeef2",
      "#d0d7de",
      "#b1bac4",
      "#848d97",
      "#57606a",
      "#424a53",
      "#32383f",
      "#24292f",
      "#0d1117",
    ],
  },

  other: {
    transition: "all 200ms ease",
  },

  cursorType: "pointer",
};
