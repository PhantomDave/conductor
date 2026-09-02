import type { ReactNode } from "react";
import { Group, Text } from "@mantine/core";

interface SectionHeadingProps {
  children: ReactNode;
  right?: ReactNode;
}

/** A page-section label styled like a terminal comment: "# processes ————". */
export function SectionHeading({ children, right }: SectionHeadingProps) {
  return (
    <Group gap="sm" wrap="nowrap" align="center">
      <Text component="span" fw={600} size="sm" style={{ flexShrink: 0, textTransform: "lowercase" }}>
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
