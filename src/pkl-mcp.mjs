// Local transport only. OpenCode supplies session identity in MCP metadata,
// after its native permission check; identity is never taken from tool input.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { setupPkl } from "./pkl.mjs";

const tools = new Map();
const dispose = await setupPkl({
  options: JSON.parse(process.argv[2]),
  tool: { transform: async (register) => register({ add: (tool) => tools.set(tool.name, tool) }) },
});
const server = new Server({ name: "canix-pkl", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...tools.values()].map(({ name, description, input }) => ({ name, description, inputSchema: input })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
  const sessionID = request.params._meta?.["ai.opencode/sessionID"];
  if (typeof sessionID !== "string" || !sessionID.startsWith("ses_")) {
    throw new Error("Pkl requires OpenCode session metadata");
  }
  const tool = tools.get(request.params.name);
  if (!tool) throw new Error("Unknown Pkl tool");
  const result = await tool.execute(request.params.arguments ?? {}, { sessionID, signal: context.signal });
  return { content: [{ type: "text", text: result.content }] };
});
let closing;
const close = () => closing ??= (async () => { await dispose(); await server.close(); })();
server.onclose = () => { void close(); };
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void close(); });
await server.connect(new StdioServerTransport());
