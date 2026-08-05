import { LineChart } from "@mantine/charts";
import { Card, Group, Popover, Text, Button } from "@mantine/core";
import { IconTrendingUp } from "@tabler/icons-react";
import { useState } from "react";
import { fetchProcessMetrics } from "../lib/api";

interface MetricPoint {
  timestamp: string;
  cpu_percent: number | null;
  memory_bytes: number | null;
}

export function MetricButton({ pid }: { pid: number }) {
  const [visible, setVisible] = useState(false);
  const [data, setData] = useState<MetricPoint[]>([]);
  const [loading, setLoading] = useState(false);

  const open = async () => {
    if (data.length === 0 && !loading) {
      setLoading(true);
      try {
        const rows = await fetchProcessMetrics(pid);
        setData(rows as MetricPoint[]);
      } finally {
        setLoading(false);
      }
    }
    setVisible((v) => !v);
  };

  return (
    <Popover width={600} position="bottom" withArrow shadow="lg">
      <Popover.Target>
        <button
          type="button"
          onClick={open}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
          <IconTrendingUp size={18} color="#82ca9d" />
        </button>
      </Popover.Target>

      {visible && (
        <Popover.Dropdown>
          <Card style={{ padding: "1rem", minWidth: 500 }}>
            <Group justify="space-between" mb="md">
              <Text fw={500} size="sm">
                Metrics for PID {pid}
              </Text>
              <Button size="xs" variant="subtle" onClick={() => setVisible(false)}>
                Close
              </Button>
            </Group>

            {loading ? (
              <Text c="dimmed" size="sm">
                Loading metrics...
              </Text>
            ) : data.length === 0 ? (
              <Text c="dimmed" size="sm">
                No metrics data available yet
              </Text>
            ) : (
              (() => {
                const memRows = data.map((d) => ({
                  timestamp: d.timestamp,
                  memory_mb: d.memory_bytes != null ? Math.round(d.memory_bytes / 1048576) : null,
                }));

                return (
                  <>
                    {/* CPU */}
                    <Text size="xs" fw={500}>
                      CPU %
                    </Text>
                    <LineChart
                      h={120}
                      w={"100%"}
                      data={data}
                      dataKey="timestamp"
                      curveType="monotone"
                      withDots={false}
                      xAxisProps={{ tickMargin: 5 }}
                      series={[{ name: "cpu_percent", color: "#82ca9d" }]}
                    />

                    {/* Memory */}
                    <Text size="xs" fw={500} mt="lg">
                      Memory (RSS)
                    </Text>
                    <LineChart
                      h={120}
                      w={"100%"}
                      data={memRows}
                      dataKey="timestamp"
                      curveType="monotone"
                      withDots={false}
                      unit="MB"
                      valueFormatter={(v) => `${Math.round(v as number)} MB`}
                      yAxisProps={{ tickMargin: 5 }}
                      series={[{ name: "memory_mb", color: "#42a5f5" }]}
                    />
                  </>
                );
              })()
            )}
          </Card>
        </Popover.Dropdown>
      )}
    </Popover>
  );
}
