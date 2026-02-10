/* eslint-disable no-console */
// MCP stdio server that simulates a screenshot tool writing into a temp dir and
// returning the temp path in text output.

const { writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

async function main() {
  const server = new Server({ name: 'screenshot-mcp-server', version: '0.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'take_screenshot',
          description: 'Simulate screenshot output',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
              fullPage: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'take_screenshot') {
      return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
    }

    const a = req.params.arguments || {};
    const keys = Object.keys(a);
    const ok = keys.every((k) => k === 'filePath' || k === 'fullPage');
    if (!ok) {
      return {
        content: [
          {
            type: 'text',
            text: `Invalid arguments: expected only { filePath?: string, fullPage?: boolean }, got keys: ${keys.join(', ')}`,
          },
        ],
        isError: true,
      };
    }

    if (process.env.FAIL_ON_FILEPATH === '1' && a.filePath) {
      return {
        content: [
          {
            type: 'text',
            text: `ENOENT: no such file or directory, mkdir '${String(a.filePath)}'`,
          },
        ],
        isError: true,
      };
    }

    const dir = join(tmpdir(), `chrome-devtools-mcp-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const src = join(dir, 'screenshot.png');
    // minimal PNG header + dummy bytes
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    writeFileSync(src, buf);

    return {
      content: [{ type: 'text', text: `Saved screenshot to ${src}` }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
