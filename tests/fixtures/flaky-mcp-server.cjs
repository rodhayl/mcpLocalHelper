/* eslint-disable no-console */
// A tiny MCP stdio server that fails N times before starting successfully.
// Used to test McpClientManager retry logic.

const { existsSync, readFileSync, writeFileSync } = require('fs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

function bumpCounter(filePath) {
  let n = 0;
  if (existsSync(filePath)) {
    try {
      n = Number.parseInt(readFileSync(filePath, 'utf8'), 10) || 0;
    } catch {}
  }
  n += 1;
  writeFileSync(filePath, String(n), 'utf8');
  return n;
}

async function main() {
  const counterFile = process.env.COUNTER_FILE;
  const fails = Number.parseInt(process.env.FAILS || '0', 10) || 0;

  if (!counterFile) {
    console.error('COUNTER_FILE is required');
    process.exit(2);
  }

  const attempt = bumpCounter(counterFile);
  if (attempt <= fails) {
    console.error(`Intentional failure attempt ${attempt}/${fails}`);
    process.exit(1);
  }

  const server = new Server(
    { name: 'flaky-mcp-server', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'echo',
          description: 'Echo args',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
        {
          name: 'fail',
          description: 'Always returns isError',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'echo') {
      const a = req.params.arguments || {};
      const keys = Object.keys(a);
      const ok = typeof a.text === 'string' && keys.every((k) => k === 'text');
      if (!ok) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid arguments: expected only { text: string }, got keys: ${keys.join(', ')}`,
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: String(a.text || '') }] };
    }
    if (req.params.name === 'fail') {
      return { content: [{ type: 'text', text: 'forced failure' }], isError: true };
    }
    return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
