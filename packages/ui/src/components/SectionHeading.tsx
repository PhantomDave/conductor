import type { ReactNode } from "react";
import { Group, Text } from "@mantine/core";

interface SectionHeadingProps {
  children: ReactNode;
  right?: ReactNode;
  /** Heading level for the rendered <h1>-<h6> element. Every current call
   * site is a view's top-level section header, so this defaults to h2 —
   * pass an explicit level only for a heading nested under another one. */
  order?: 1 | 2 | 3 | 4 | 5 | 6;
}

/** A page-section label styled like a terminal comment: "# processes ————".
 * Renders a real heading element (not just heading-shaped text) so it stays
 * in the accessibility heading outline / screen-reader heading navigation. */
export function SectionHeading({ children, right, order = 2 }: SectionHeadingProps) {
  return (
    <Group gap="sm" wrap="nowrap" align="center">
      <Text
        component={`h${order}` as "h2"}
        fw={600}
        size="sm"
        m={0}
        style={{ flexShrink: 0, textTransform: "lowercase" }}
      >
        <span style={{ color: "var(--mantine-color-green-5)" }}>#</span> {children}
      </Text>
      <div style={{ flex: 1, height: 1, background: "var(--mantine-color-dark-5)" }} />
      {right && (
        <Text component="span" size="xs" c="dimmed" style={{ flexShrink: 0 }}>
          {right}
        </Text>
      )}
    </Group>
  );
}
