import { useEffect, useState } from "react";
import {
  Tabs,
  Stack,
  Group,
  Table,
  TextInput,
  Button,
  ActionIcon,
  Badge,
  Text,
  Modal,
  Checkbox,
  Textarea,
  Title,
  Card,
  Code,
  Select,
  List,
  Alert,
} from "@mantine/core";
import {
  IconPlus,
  IconTrash,
  IconEye,
  IconEyeOff,
  IconUpload,
  IconFolder,
  IconFileSymlink,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";
import { useProfiles } from "../hooks/useProfiles";
import {
  useEnvVars,
  useUpsertEnvVar,
  useDeleteEnvVar,
  useImportEnvVars,
  useBasePath,
  useUpdateBasePath,
  useCompileConfigExamples,
} from "../hooks/useEnvVars";
import type { EnvVarRow, CompileReport } from "../lib/api";

function BasePathCard() {
  const { data, isLoading } = useBasePath();
  const update = useUpdateBasePath();
  const [value, setValue] = useState("");

  // Keep the input in sync with the loaded value, but don't clobber
  // whatever the user is actively typing on refetches.
  useEffect(() => {
    if (data && value === "") setValue(data.base_path);
  }, [data]);

  const dirty = data && value !== data.base_path && value.trim() !== "";

  return (
    <Card withBorder padding="md">
      <Stack gap="xs">
        <Group gap={6}>
          <IconFolder size={18} />
          <Title order={4}>Base path</Title>
        </Group>
        <Text size="sm" c="dimmed">
          Where the target application is installed on disk. Relative <Code>cwd</Code> values on
          commands (and relative healthcheck commands) resolve against this path instead of
          wherever the Conductor server happens to be running from. It's also injected into every
          command as <Code>{"${BASE_PATH}"}</Code>, so you can build other paths from it - e.g. a
          sibling checkout at <Code>{"${BASE_PATH}/../my-app"}</Code>.
        </Text>
        {isLoading ? (
          <Text c="dimmed" size="sm">
            Loading...
          </Text>
        ) : (
          <Group align="flex-end">
            <TextInput
              style={{ flex: 1 }}
              placeholder="."
              value={value}
              onChange={(e) => setValue(e.currentTarget.value)}
            />
            <Button
              disabled={!dirty}
              loading={update.isPending}
              onClick={() => update.mutate(value.trim())}
            >
              Save
            </Button>
          </Group>
        )}
        {data && (
          <Text size="xs" c="dimmed">
            Resolves to <Code>{data.resolved}</Code>
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function ConfigCompilerCard({ profileNames }: { profileNames: string[] }) {
  const compile = useCompileConfigExamples();
  const [profile, setProfile] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [report, setReport] = useState<CompileReport | null>(null);

  const run = () => {
    compile.mutate(
      { profile: profile ?? undefined, force },
      { onSuccess: setReport },
    );
  };

  return (
    <Card withBorder padding="md">
      <Stack gap="xs">
        <Group gap={6}>
          <IconFileSymlink size={18} />
          <Title order={4}>Config files</Title>
        </Group>
        <Text size="sm" c="dimmed">
          Scans <Code>base_path</Code> for <Code>.env.example</Code> / <Code>appsettings.example.json</Code>
          -style files and creates the real file next to each one, with any <Code>{"${VAR}"}</Code> tokens
          filled in from this profile's resolved environment. Existing files are never overwritten unless
          "Overwrite existing" is checked, so it's always safe to re-run - including automatically, every
          time you run a profile. This also runs automatically before starting a profile, so a fresh
          checkout with new services just works with no extra setup step.
        </Text>
        <Group align="flex-end">
          <Select
            style={{ flex: 1 }}
            placeholder="Global only (no profile env)"
            clearable
            data={profileNames}
            value={profile}
            onChange={setProfile}
          />
          <Checkbox
            label="Overwrite existing"
            checked={force}
            onChange={(e) => setForce(e.currentTarget.checked)}
          />
          <Button loading={compile.isPending} onClick={run}>
            Compile
          </Button>
        </Group>

        {report && (
          <Stack gap={4}>
            <Text size="sm">
              <Text span fw={600} c="green">
                {report.created} created
              </Text>
              {", "}
              <Text span c="dimmed">
                {report.skipped} already existed
              </Text>
              {report.errors > 0 && (
                <>
                  {", "}
                  <Text span fw={600} c="red">
                    {report.errors} failed
                  </Text>
                </>
              )}
            </Text>
            {report.results.length > 0 && (
              <List size="xs" spacing={2}>
                {report.results.map((r) => (
                  <List.Item key={r.targetPath}>
                    <Text span ff="monospace" size="xs">
                      {r.targetPath.replace(`${report.basePath}/`, "")}
                    </Text>{" "}
                    <Text
                      span
                      size="xs"
                      c={r.action === "created" ? "green" : r.action === "error" ? "red" : "dimmed"}
                    >
                      {r.action === "created" && "created"}
                      {r.action === "skipped-exists" && "already exists"}
                      {r.action === "error" && `error: ${r.error}`}
                    </Text>
                  </List.Item>
                ))}
              </List>
            )}
            {report.results.length === 0 && (
              <Text size="xs" c="dimmed">
                No <Code>*.example*</Code> files found under {report.basePath}.
              </Text>
            )}
            {report.missingVars.length > 0 && (
              <Alert
                color="yellow"
                variant="light"
                icon={<IconAlertTriangle size={16} />}
                title="Missing values"
              >
                These <Code>{"${VAR}"}</Code> tokens had no value and were left blank - add them
                below (Global or this profile) then compile again with "Overwrite existing" checked:{" "}
                <Text span ff="monospace" size="xs">
                  {report.missingVars.join(", ")}
                </Text>
              </Alert>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

function EnvVarTable({ scope, profile }: { scope: "global" | "profile"; profile?: string }) {
  const { data: vars, isLoading } = useEnvVars(scope, profile);
  const upsert = useUpsertEnvVar();
  const remove = useDeleteEnvVar();
  const importVars = useImportEnvVars();
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [addOpen, addHandlers] = useDisclosure(false);
  const [importOpen, importHandlers] = useDisclosure(false);
  const [form, setForm] = useState({ key: "", value: "", secret: false });
  const [importText, setImportText] = useState("");

  const toggleReveal = (id: number) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const submitAdd = () => {
    if (!form.key.trim()) return;
    upsert.mutate(
      { scope, profile: profile ?? null, key: form.key.trim(), value: form.value, secret: form.secret },
      { onSuccess: () => addHandlers.close() },
    );
    setForm({ key: "", value: "", secret: false });
  };

  const submitImport = () => {
    if (!importText.trim()) return;
    importVars.mutate(
      { scope, profile: profile ?? null, text: importText },
      { onSuccess: () => { importHandlers.close(); setImportText(""); } },
    );
  };

  if (isLoading) return <Text c="dimmed">Loading...</Text>;

  return (
    <Stack gap="sm">
      <Group justify="flex-end">
        <Button size="xs" variant="light" leftSection={<IconUpload size={14} />} onClick={importHandlers.open}>
          Import .env
        </Button>
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={addHandlers.open}>
          Add variable
        </Button>
      </Group>

      {!vars || vars.length === 0 ? (
        <Text c="dimmed" size="sm">
          No variables yet.
        </Text>
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Key</Table.Th>
              <Table.Th>Value</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {vars.map((v: EnvVarRow) => (
              <Table.Tr key={v.id}>
                <Table.Td>
                  <Group gap={6}>
                    <Text fw={500} size="sm">
                      {v.key}
                    </Text>
                    {v.is_secret === 1 && (
                      <Badge size="xs" color="orange" variant="light">
                        secret
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    <Text size="sm" ff="monospace">
                      {v.is_secret === 1 && !revealed.has(v.id) ? "••••••••" : v.value}
                    </Text>
                    {v.is_secret === 1 && (
                      <ActionIcon size="xs" variant="subtle" onClick={() => toggleReveal(v.id)}>
                        {revealed.has(v.id) ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                      </ActionIcon>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <ActionIcon
                    color="red"
                    variant="subtle"
                    loading={remove.isPending && remove.variables === v.id}
                    onClick={() => remove.mutate(v.id)}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <Modal opened={addOpen} onClose={addHandlers.close} title="Add environment variable">
        <Stack>
          <TextInput
            label="Key"
            placeholder="API_URL"
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.currentTarget.value })}
          />
          <TextInput
            label="Value"
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.currentTarget.value })}
          />
          <Checkbox
            label="Treat as secret (masked in the UI and logs)"
            checked={form.secret}
            onChange={(e) => setForm({ ...form, secret: e.currentTarget.checked })}
          />
          <Button loading={upsert.isPending} onClick={submitAdd}>
            Save
          </Button>
        </Stack>
      </Modal>

      <Modal opened={importOpen} onClose={importHandlers.close} title="Import .env" size="lg">
        <Stack>
          <Text size="sm" c="dimmed">
            Paste `.env`-style content below. Keys that look like secrets (containing "secret",
            "token", "password", "key") are marked as secret automatically.
          </Text>
          <Textarea
            autosize
            minRows={8}
            placeholder={"API_URL=http://localhost:3000\nAPI_TOKEN=abc123"}
            value={importText}
            onChange={(e) => setImportText(e.currentTarget.value)}
          />
          <Button loading={importVars.isPending} onClick={submitImport}>
            Import
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}

export function EnvironmentManager() {
  const { data: profiles } = useProfiles();
  const profileNames = Object.keys(profiles ?? {});

  return (
    <Stack gap="md">
      <div>
        <Title order={2}>Environment</Title>
        <Text c="dimmed" size="sm">
          Variables stored here live in Conductor's local database, not in .conductor.yml, so
          secrets never need to be committed to source control.
        </Text>
      </div>

      <BasePathCard />
      <ConfigCompilerCard profileNames={profileNames} />

      <Tabs defaultValue="global">
        <Tabs.List>
          <Tabs.Tab value="global">Global</Tabs.Tab>
          {profileNames.map((name) => (
            <Tabs.Tab key={name} value={name}>
              {name}
            </Tabs.Tab>
          ))}
        </Tabs.List>

        <Tabs.Panel value="global" pt="md">
          <EnvVarTable scope="global" />
        </Tabs.Panel>
        {profileNames.map((name) => (
          <Tabs.Panel key={name} value={name} pt="md">
            <EnvVarTable scope="profile" profile={name} />
          </Tabs.Panel>
        ))}
      </Tabs>
    </Stack>
  );
}
