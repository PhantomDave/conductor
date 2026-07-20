#!/usr/bin/env bun
import { Command } from "commander";
import { registerRunCommand } from "../src/commands/run";
import { registerConfigureCommand } from "../src/commands/configure";
import { registerListCommand } from "../src/commands/list";
import { registerConfigCommand } from "../src/commands/config";
import { registerEnvCommand } from "../src/commands/env";
import { registerPsCommand, registerStopCommand } from "../src/commands/ps";
import { registerLogsCommand } from "../src/commands/logs";

const program = new Command();

program.name("conductor").description("Universal task runner & dashboard").version("0.1.0");

registerRunCommand(program);
registerConfigureCommand(program);
registerListCommand(program);
registerConfigCommand(program);
registerEnvCommand(program);
registerPsCommand(program);
registerStopCommand(program);
registerLogsCommand(program);

program.parse(process.argv);
