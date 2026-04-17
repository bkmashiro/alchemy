#!/usr/bin/env node
// src/cli/commands/mcp.ts
// alchemy mcp — start the MCP server for AI agent tool-call access

import { Command } from 'commander';
import chalk from 'chalk';

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Start the Alchemy MCP server (StdioServerTransport) for AI agent integration')
    .action(async () => {
      try {
        const { startMcpServer } = await import('../../mcp/server.js');
        await startMcpServer();
      } catch (err) {
        console.error(chalk.red(`MCP server error: ${String(err)}`));
        process.exit(1);
      }
    });
}
