#!/usr/bin/env node
/**
 * Minimal MCP stdio server fixture for integration tests.
 * Exposes two tools: `echo` and `add`.
 *
 * Usage: node echo-mcp-server.mjs
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'echo-fixture', version: '1.0.0' },
  {
    capabilities: { tools: {} },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echoes the input message back.',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string', description: 'Message to echo' } },
        required: ['message'],
      },
    },
    {
      name: 'add',
      description: 'Adds two numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First operand' },
          b: { type: 'number', description: 'Second operand' },
        },
        required: ['a', 'b'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'echo') {
    return { content: [{ type: 'text', text: String(args?.message ?? '') }], isError: false };
  }

  if (name === 'add') {
    const result = Number(args?.a ?? 0) + Number(args?.b ?? 0);
    return { content: [{ type: 'text', text: String(result) }], isError: false };
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
