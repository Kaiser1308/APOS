#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program.name('apos').description('Local AI Project Orchestration System').version('0.1.0');
program.parse();
