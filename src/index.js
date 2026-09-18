import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3000);
const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || "").replace(/\/+$/, "");
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";
const BRIDGE_API_KEY = process.env.API_KEY || "";

if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
  console.error("[evolution-mcp] EVOLUTION_API_URL and EVOLUTION_API_KEY are required");
  process.exit(1);
}

// ---------- Evolution API client ----------
async function evo(path, { method = "GET", body } = {}) {
  const res = await fetch(`${EVOLUTION_API_URL}${path}`, {
    method,
    headers: {
      apikey: EVOLUTION_API_KEY,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`Evolution API ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return data;
}

// ---------- MCP server ----------
const server = new McpServer({
  name: "evolution-mcp",
  version: "1.0.0",
});

server.tool(
  "list_instances",
  "List all WhatsApp instances registered in Evolution API",
  {},
  async () => {
    const data = await evo("/instance/fetchInstances");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "create_instance",
  "Create a new WhatsApp instance in Evolution API (Baileys by default). Returns instance data; then use get_qrcode to pair the phone.",
  {
    instanceName: z.string().describe("Unique instance name (lowercase, no spaces)"),
    integration: z
      .enum(["WHATSAPP-BAILEYS", "WHATSAPP-BUSINESS"])
      .default("WHATSAPP-BAILEYS")
      .describe("Connection type"),
    qrcode: z.boolean().default(true).describe("Generate QR code for pairing"),
    number: z.string().optional().describe("Phone number (Cloud API only)"),
    token: z.string().optional().describe("Instance token / webhook signature secret"),
  },
  async ({ instanceName, integration, qrcode, number, token }) => {
    const body = { instanceName, integration, qrcode };
    if (number) body.number = number;
    if (token) body.token = token;
    const data = await evo("/instance/create", { method: "POST", body });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_qrcode",
  "Get the QR code (base64) to pair a WhatsApp number with an instance. The user must scan it with WhatsApp > Linked devices.",
  {
    instance: z.string().describe("Instance name"),
  },
  async ({ instance }) => {
    const data = await evo(`/instance/connect/${encodeURIComponent(instance)}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "connection_status",
  "Check whether an instance is connected (open/close) to WhatsApp",
  {
    instance: z.string().describe("Instance name"),
  },
  async ({ instance }) => {
    const data = await evo(`/instance/connectionState/${encodeURIComponent(instance)}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "send_text",
  "Send a text message to a WhatsApp number (E.164 format, e.g. 5511999999999)",
  {
    instance: z.string().describe("Instance name"),
    number: z.string().describe("Destination number in E.164 format"),
    text: z.string().describe("Message text"),
  },
  async ({ instance, number, text }) => {
    const data = await evo(`/message/sendText/${encodeURIComponent(instance)}`, {
      method: "POST",
      body: { number, text },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "set_webhook",
  "Configure the webhook URL for an instance to receive WhatsApp events (messages, qrcode, connection updates)",
  {
    instance: z.string().describe("Instance name"),
    url: z.string().describe("Public HTTPS webhook URL"),
    enabled: z.boolean().default(true),
    events: z
      .array(z.string())
      .optional()
      .describe("Event names, e.g. MESSAGES_UPSERT, CONNECTION_UPDATE, QRCODE_UPDATED"),
  },
  async ({ instance, url, enabled, events }) => {
    const body = { webhook: { url, enabled } };
    if (events && events.length) body.webhook.events = events;
    const data = await evo(`/webhook/set/${encodeURIComponent(instance)}`, {
      method: "POST",
      body,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "disconnect_instance",
  "Log a WhatsApp number out of an instance (disconnects the session)",
  {
    instance: z.string().describe("Instance name"),
  },
  async ({ instance }) => {
    const data = await evo(`/instance/logout/${encodeURIComponent(instance)}`, {
      method: "DELETE",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ---------- HTTP transport ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", server: "evolution-mcp", version: "1.0.0" });
});

// Simple API key auth for the MCP endpoint
function checkAuth(req, res, next) {
  if (!BRIDGE_API_KEY) return next();
  const provided =
    req.headers["x-api-key"] ||
    (req.headers.authorization && req.headers.authorization.replace(/^Bearer\s+/i, ""));
  if (provided && provided === BRIDGE_API_KEY) return next();
  res.setHeader("WWW-Authenticate", 'Bearer realm="evolution-mcp"');
  return res.status(401).json({ error: "Unauthorized" });
}

let transport;
app.post("/mcp", checkAuth, async (req, res) => {
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      onsessioninitialized: () => {},
    });
    await server.connect(transport);
  }
  await transport.handleRequest(req, res);
});

app.get("/mcp", checkAuth, async (req, res) => {
  if (!transport) {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete("/mcp", checkAuth, async (req, res) => {
  if (!transport) {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`[evolution-mcp] listening on :${PORT}`);
});