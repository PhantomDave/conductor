import { useEffect, useState } from "react";
import {
  Modal,
  Stack,
  TextInput,
  Textarea,
  Switch,
  Select,
  NumberInput,
  MultiSelect,
  Button,
  Group,
  Divider,
  Text,
  ActionIcon,
} from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useCreateCommand, useUpdateCommand } from "../hooks/useConfig";
import type { CommandInfo, CommandInput, HealthcheckInfo } from "../lib/api";

interface CommandFormProps {
  opened: boolean;
  onClose: () => void;
  profile: string;
  /** Existing commands in the profile, used for the dependency picker. */
  existingCommands: CommandInfo[];
  /** When set, the form edits this command instead of creating a new one. */
  editing?: CommandInfo | null;
}

const DEFAULT_HEALTHCHECK: HealthcheckInfo = {
  type: "none",
  interval_ms: 1000,
  timeout_ms: 10000,
  retries: 10,
};

export function CommandForm({ opened, onClose, profile, existingCommands, editing }: CommandFormProps) {
  const createCommand = useCreateCommand();
  const updateCommand = useUpdateCommand();
  const isEditing = Boolean(editing);

  const [name, setName] = useState("");
  const [run, setRun] = useState("");
  const [cwd, setCwd] = useState(".");
  const [shell, setShell] = useState(true);
  const [deps, setDeps] = useState<string[]>([]);
  const [watch, setWatch] = useState("");
  const [readonly, setReadonly] = useState(false);
  const [stopSignal, setStopSignal] = useState("SIGTERM");
  const [stopTimeoutMs, setStopTimeoutMs] = useState(5000);
  const [envOverrides, setEnvOverrides] = useState<Array<{ key: string; value: string }>>([]);
  const [healthcheck, setHealthcheck] = useState<HealthcheckInfo>(DEFAULT_HEALTHCHECK);

  useEffect(() => {
    if (!opened) return;
    if (editing) {
      setName(editing.name);
      setRun(editing.run);
      setCwd(editing.cwd || ".");
      setShell(editing.shell);
      setDeps(editing.deps ?? []);
      setWatch((editing.watch ?? []).join(", "));
      setReadonly(editing.readonly);
      setStopSignal(editing.stop_signal || "SIGTERM");
      setStopTimeoutMs(editing.stop_timeout_ms ?? 5000);
      setEnvOverrides(Object.entries(editing.env_overrides ?? {}).map(([key, value]) => ({ key, value })));
      setHealthcheck(editing.healthcheck ?? DEFAULT_HEALTHCHECK);
    } else {
      setName("");
      setRun("");
      setCwd(".");
      setShell(true);
      setDeps([]);
      setWatch("");
      setReadonly(false);
      setStopSignal("SIGTERM");
      setStopTimeoutMs(5000);
      setEnvOverrides([]);
      setHealthcheck(DEFAULT_HEALTHCHECK);
    }
  }, [opened, editing]);

  const depOptions = existingCommands.filter((c) => c.id !== editing?.id).map((c) => ({ value: c.id, label: c.name }));

  const submit = () => {
    if (!name.trim() || !run.trim()) return;

    const env_overrides = Object.fromEntries(
      envOverrides.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e.value]),
    );
    const watchList = watch
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);

    const input: CommandInput = {
      name: name.trim(),
      run: run.trim(),
      cwd,
      shell,
      deps,
      env_overrides,
      watch: watchList,
      readonly,
      stop_signal: stopSignal,
      stop_timeout_ms: stopTimeoutMs,
      healthcheck: healthcheck.type === "none" ? undefined : healthcheck,
    };

    if (isEditing && editing) {
      updateCommand.mutate({ profile, commandId: editing.id, patch: input }, { onSuccess: onClose });
    } else {
      createCommand.mutate({ profile, input }, { onSuccess: onClose });
    }
  };

  const isPending = createCommand.isPending || updateCommand.isPending;

  return (
    <Modal opened={opened} onClose={onClose} title={isEditing ? "Edit command" : "New command"} size="lg">
      <Stack>
        <TextInput label="Name" placeholder="web-server" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
        <Textarea
          label="Command"
          placeholder="bun run start"
          value={run}
          onChange={(e) => setRun(e.currentTarget.value)}
          autosize
          minRows={2}
          required
        />
        <Group grow>
          <TextInput label="Working directory" value={cwd} onChange={(e) => setCwd(e.currentTarget.value)} />
          <Switch label="Run through shell" checked={shell} onChange={(e) => setShell(e.currentTarget.checked)} mt="xl" />
        </Group>

        <MultiSelect
          label="Depends on"
          placeholder="Select commands that must be healthy first"
          data={depOptions}
          value={deps}
          onChange={setDeps}
          searchable
        />

        <TextInput
          label="Watch paths (comma-separated, optional)"
          placeholder="src/**/*.ts, package.json"
          value={watch}
          onChange={(e) => setWatch(e.currentTarget.value)}
        />

        <Group grow>
          <Select
            label="Stop signal"
            data={["SIGTERM", "SIGINT", "SIGKILL"]}
            value={stopSignal}
            onChange={(v) => setStopSignal(v ?? "SIGTERM")}
          />
          <NumberInput label="Stop timeout (ms)" value={stopTimeoutMs} onChange={(v) => setStopTimeoutMs(Number(v) || 0)} min={0} />
        </Group>

        <Switch label="Read-only (cannot be started/stopped from the UI)" checked={readonly} onChange={(e) => setReadonly(e.currentTarget.checked)} />

        <Divider label="Environment overrides" labelPosition="left" />
        <Stack gap="xs">
          {envOverrides.map((entry, idx) => (
            <Group key={idx} gap="xs">
              <TextInput
                placeholder="KEY"
                value={entry.key}
                onChange={(e) =>
                  setEnvOverrides((prev) => prev.map((p, i) => (i === idx ? { ...p, key: e.currentTarget.value } : p)))
                }
                flex={1}
              />
              <TextInput
                placeholder="value"
                value={entry.value}
                onChange={(e) =>
                  setEnvOverrides((prev) => prev.map((p, i) => (i === idx ? { ...p, value: e.currentTarget.value } : p)))
                }
                flex={1}
              />
              <ActionIcon color="red" variant="subtle" onClick={() => setEnvOverrides((prev) => prev.filter((_, i) => i !== idx))}>
                <IconTrash size={14} />
              </ActionIcon>
            </Group>
          ))}
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={() => setEnvOverrides((prev) => [...prev, { key: "", value: "" }])}
          >
            Add variable
          </Button>
        </Stack>

        <Divider label="Healthcheck" labelPosition="left" />
        <Text size="xs" c="dimmed">
          Commands that depend on this one will wait until it reports healthy before starting.
        </Text>
        <Select
          label="Type"
          data={[
            { value: "none", label: "None (started = healthy)" },
            { value: "port", label: "TCP port" },
            { value: "http", label: "HTTP request" },
            { value: "command", label: "Shell command exits 0" },
          ]}
          value={healthcheck.type}
          onChange={(v) => setHealthcheck((prev) => ({ ...prev, type: (v as HealthcheckInfo["type"]) ?? "none" }))}
        />
        {healthcheck.type === "port" && (
          <NumberInput
            label="Port"
            value={healthcheck.port ?? 0}
            onChange={(v) => setHealthcheck((prev) => ({ ...prev, port: Number(v) || 0 }))}
          />
        )}
        {healthcheck.type === "http" && (
          <TextInput
            label="URL"
            placeholder="http://localhost:3000/health"
            value={healthcheck.url ?? ""}
            onChange={(e) => setHealthcheck((prev) => ({ ...prev, url: e.currentTarget.value }))}
          />
        )}
        {healthcheck.type === "command" && (
          <TextInput
            label="Command"
            placeholder="curl -f http://localhost:3000/health"
            value={healthcheck.command ?? ""}
            onChange={(e) => setHealthcheck((prev) => ({ ...prev, command: e.currentTarget.value }))}
          />
        )}
        {healthcheck.type !== "none" && (
          <Group grow>
            <NumberInput
              label="Interval (ms)"
              value={healthcheck.interval_ms}
              onChange={(v) => setHealthcheck((prev) => ({ ...prev, interval_ms: Number(v) || 0 }))}
            />
            <NumberInput
              label="Timeout (ms)"
              value={healthcheck.timeout_ms}
              onChange={(v) => setHealthcheck((prev) => ({ ...prev, timeout_ms: Number(v) || 0 }))}
            />
            <NumberInput
              label="Retries"
              value={healthcheck.retries}
              onChange={(v) => setHealthcheck((prev) => ({ ...prev, retries: Number(v) || 0 }))}
            />
          </Group>
        )}

        <Group justify="flex-end" mt="md">
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={isPending}>
            {isEditing ? "Save changes" : "Create command"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
