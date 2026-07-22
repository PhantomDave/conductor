import { Modal, Stack, Textarea, Button, Table, Badge, Group, Text, FileInput, Loader, Select } from "@mantine/core";
import { useState } from "react";
import { useParseDockerCompose } from "../hooks/useConfig";
import type { SuggestedCommand, ProfileInfo } from "../lib/api";

interface DockerComposeImporterProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly onImport: (profile: string, commands: SuggestedCommand[]) => void;
  readonly profiles?: Record<string, ProfileInfo>;
}

export function DockerComposeImporter({ opened, onClose, onImport, profiles }: DockerComposeImporterProps) {
  const [yamlText, setYamlText] = useState("");
  const [selectedCommands, setSelectedCommands] = useState<Set<string>>(new Set());
  const [targetProfile, setTargetProfile] = useState<string | null>(null);
  const parseDocker = useParseDockerCompose();

  const suggestions = parseDocker.data || [];
  const hasResults = suggestions.length > 0;
  const profileOptions = Object.keys(profiles || {});

  const handleFileUpload = async (file: File | null) => {
    if (file) {
      const text = await file.text();
      setYamlText(text);
      parseDocker.mutate(text);
    }
  };

  const handleParse = () => {
    if (yamlText.trim()) {
      parseDocker.mutate(yamlText);
    }
  };

  const handleImport = () => {
    if (!targetProfile) {
      return;
    }
    const toImport = suggestions.filter((cmd) => selectedCommands.has(cmd.id));
    if (toImport.length > 0) {
      onImport(targetProfile, toImport);
      setYamlText("");
      setSelectedCommands(new Set());
      setTargetProfile(null);
      parseDocker.reset();
      onClose();
    }
  };

  const handleClose = () => {
    setYamlText("");
    setSelectedCommands(new Set());
    setTargetProfile(null);
    parseDocker.reset();
    onClose();
  };

  const toggleCommand = (id: string) => {
    const updated = new Set(selectedCommands);
    if (updated.has(id)) {
      updated.delete(id);
    } else {
      updated.add(id);
    }
    setSelectedCommands(updated);
  };

  const toggleAllCommands = () => {
    if (selectedCommands.size === suggestions.length) {
      setSelectedCommands(new Set());
    } else {
      setSelectedCommands(new Set(suggestions.map((cmd) => cmd.id)));
    }
  };

  return (
    <Modal opened={opened} onClose={handleClose} title="Import from docker compose.yml" size="lg">
      <Stack gap="md">
        <Select
          label="Target Profile"
          placeholder="Select where to import commands"
          data={profileOptions}
          value={targetProfile}
          onChange={setTargetProfile}
          searchable
          clearable
        />

        {!hasResults ? (
          <>
            <Stack gap="sm">
              <Text size="sm">Paste your docker compose.yml content or upload a file:</Text>
              <Textarea
                label="YAML Content"
                placeholder="version: '3'&#10;services:&#10;  web:&#10;    image: nginx&#10;    ports:&#10;      - '80:80'"
                value={yamlText}
                onChange={(e) => setYamlText(e.currentTarget.value)}
                minRows={6}
              />
              <FileInput
                label="Or upload YAML file"
                placeholder="Choose file"
                accept=".yml,.yaml"
                onChange={handleFileUpload}
              />
            </Stack>
            <Button onClick={handleParse} loading={parseDocker.isPending} disabled={!yamlText.trim()}>
              Parse docker compose.yml
            </Button>
          </>
        ) : (
          <>
            <Group justify="space-between">
              <Text fw={500}>
                Found {suggestions.length} service{suggestions.length !== 1 ? "s" : ""}
              </Text>
              <Button size="xs" variant="light" onClick={toggleAllCommands}>
                {selectedCommands.size === suggestions.length ? "Deselect all" : "Select all"}
              </Button>
            </Group>

            <div style={{ overflowX: "auto" }}>
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th style={{ width: "40px" }}>
                      <input
                        type="checkbox"
                        checked={selectedCommands.size === suggestions.length && suggestions.length > 0}
                        onChange={toggleAllCommands}
                      />
                    </Table.Th>
                    <Table.Th>Service</Table.Th>
                    <Table.Th>Start Command</Table.Th>
                    <Table.Th>Build</Table.Th>
                    <Table.Th>Health Check</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {suggestions.map((cmd) => (
                    <Table.Tr key={cmd.id}>
                      <Table.Td>
                        <input
                          type="checkbox"
                          checked={selectedCommands.has(cmd.id)}
                          onChange={() => toggleCommand(cmd.id)}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={500}>
                          {cmd.name}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed" style={{ maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {cmd.run}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {cmd.needsBuild ? (
                          <Badge size="sm" color="orange">
                            📦 Custom build
                          </Badge>
                        ) : (
                          <Text size="xs" c="dimmed">
                            Image
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {cmd.healthcheck ? (
                          <Badge size="sm" variant="light" color="blue">
                            {cmd.healthcheck.type}
                          </Badge>
                        ) : (
                          <Text size="xs" c="dimmed">
                            None
                          </Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>

            <Group justify="space-between">
              <Button variant="light" onClick={() => setYamlText("")}>
                Parse another file
              </Button>
              <Group>
                <Button variant="light" onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  onClick={handleImport}
                  disabled={selectedCommands.size === 0 || !targetProfile}
                  loading={parseDocker.isPending}
                >
                  Import {selectedCommands.size} service{selectedCommands.size !== 1 ? "s" : ""}
                </Button>
              </Group>
            </Group>
          </>
        )}

        {parseDocker.isPending && (
          <Group justify="center">
            <Loader size="sm" />
            <Text size="sm">Parsing...</Text>
          </Group>
        )}

        {parseDocker.isError && (
          <Text c="red" size="sm">
            Failed to parse: {(parseDocker.error as Error)?.message}
          </Text>
        )}
      </Stack>
    </Modal>
  );
}
