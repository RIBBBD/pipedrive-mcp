import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Config (all via environment variables — nothing secret lives in code)      */
/* -------------------------------------------------------------------------- */

const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
if (!PIPEDRIVE_API_TOKEN) {
  console.error("FATAL: PIPEDRIVE_API_TOKEN is not set. Refusing to start.");
  process.exit(1);
}

// Your Pipedrive company domain, e.g. "bbd" for https://bbd.pipedrive.com .
// If unset, falls back to the generic api host, which also works with a token.
const COMPANY_DOMAIN = process.env.PIPEDRIVE_COMPANY_DOMAIN?.trim();
const BASE_URL = COMPANY_DOMAIN
  ? `https://${COMPANY_DOMAIN}.pipedrive.com/api/v1`
  : "https://api.pipedrive.com/v1";

// Unguessable path segment so the endpoint isn't wide open to anyone who
// stumbles on the host. Claude only ever sees the full URL you paste in.
// Generate one with: node -e "console.log(require('crypto').randomUUID())"
const PATH_SECRET = process.env.MCP_PATH_SECRET?.trim();
if (!PATH_SECRET) {
  console.error("FATAL: MCP_PATH_SECRET is not set. Refusing to start.");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT ?? "8080", 10);

/* -------------------------------------------------------------------------- */
/* Minimal Pipedrive REST client                                              */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

async function pd(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { query?: Record<string, string | number | undefined>; body?: Json } = {}
): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      "x-api-token": PIPEDRIVE_API_TOKEN as string,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const errObj = parsed as { error?: string; error_info?: string };
    throw new Error(
      `Pipedrive ${method} ${path} failed (${res.status}): ${
        errObj.error ?? "unknown error"
      }${errObj.error_info ? ` — ${errObj.error_info}` : ""}`
    );
  }
  return parsed;
}

// Helper: wrap a result as MCP text content.
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

/* -------------------------------------------------------------------------- */
/* MCP server + tools                                                         */
/* -------------------------------------------------------------------------- */

function buildServer(): McpServer {
  const server = new McpServer({ name: "pipedrive-mcp", version: "1.0.0" });

  /* ---- Read: pipelines & stages ---- */
  server.tool(
    "list_pipelines",
    "List all pipelines (and their IDs) in Pipedrive.",
    {},
    async () => {
      try {
        return ok(await pd("GET", "/pipelines"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "list_stages",
    "List stages, optionally filtered to one pipeline by pipeline_id.",
    { pipeline_id: z.number().int().optional().describe("Limit to a single pipeline") },
    async ({ pipeline_id }) => {
      try {
        return ok(await pd("GET", "/stages", { query: { pipeline_id } }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  /* ---- Read: deals ---- */
  server.tool(
    "list_deals",
    "List deals. Filter by status (open/won/lost/deleted/all_not_deleted), stage_id, or user_id (owner). Use limit to cap results.",
    {
      status: z
        .enum(["open", "won", "lost", "deleted", "all_not_deleted"])
        .optional(),
      stage_id: z.number().int().optional(),
      user_id: z.number().int().optional().describe("Owner user ID"),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ status, stage_id, user_id, limit }) => {
      try {
        return ok(
          await pd("GET", "/deals", { query: { status, stage_id, user_id, limit } })
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "search_deals",
    "Search deals by free-text term (matches title, notes, custom fields).",
    {
      term: z.string().min(1).describe("Search text"),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ term, limit }) => {
      try {
        return ok(await pd("GET", "/deals/search", { query: { term, limit } }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "get_deal",
    "Get full detail for a single deal by ID.",
    { deal_id: z.number().int() },
    async ({ deal_id }) => {
      try {
        return ok(await pd("GET", `/deals/${deal_id}`));
      } catch (e) {
        return fail(e);
      }
    }
  );

  /* ---- Write: deals ---- */
  server.tool(
    "create_deal",
    "Create a new deal. title is required. Optionally set value, currency, person_id, org_id, stage_id, pipeline_id.",
    {
      title: z.string().min(1),
      value: z.number().optional(),
      currency: z.string().optional().describe("e.g. GBP"),
      person_id: z.number().int().optional(),
      org_id: z.number().int().optional(),
      stage_id: z.number().int().optional(),
      pipeline_id: z.number().int().optional(),
    },
    async (args) => {
      try {
        return ok(await pd("POST", "/deals", { body: args }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "update_deal",
    "Update an existing deal by ID. Provide only the fields you want to change (e.g. move stage_id, change value, set status to won/lost).",
    {
      deal_id: z.number().int(),
      title: z.string().optional(),
      value: z.number().optional(),
      currency: z.string().optional(),
      stage_id: z.number().int().optional(),
      status: z.enum(["open", "won", "lost"]).optional(),
      person_id: z.number().int().optional(),
      org_id: z.number().int().optional(),
    },
    async ({ deal_id, ...patch }) => {
      try {
        return ok(await pd("PUT", `/deals/${deal_id}`, { body: patch }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  /* ---- Read/Write: persons ---- */
  server.tool(
    "search_persons",
    "Search people/contacts by free-text term (name, email, phone).",
    {
      term: z.string().min(1),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ term, limit }) => {
      try {
        return ok(await pd("GET", "/persons/search", { query: { term, limit } }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "create_person",
    "Create a new person/contact. name is required; email, phone and org_id optional.",
    {
      name: z.string().min(1),
      email: z.string().optional(),
      phone: z.string().optional(),
      org_id: z.number().int().optional(),
    },
    async ({ name, email, phone, org_id }) => {
      try {
        const body: Json = { name, org_id };
        if (email) body.email = [email];
        if (phone) body.phone = [phone];
        return ok(await pd("POST", "/persons", { body }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  /* ---- Write: activities & notes ---- */
  server.tool(
    "add_activity",
    "Log an activity (call, meeting, task, etc.). Link it to a deal_id and/or person_id. Set done=true to mark it complete.",
    {
      subject: z.string().min(1),
      type: z.string().default("call").describe("call, meeting, task, email, ..."),
      due_date: z.string().optional().describe("YYYY-MM-DD"),
      due_time: z.string().optional().describe("HH:MM"),
      deal_id: z.number().int().optional(),
      person_id: z.number().int().optional(),
      note: z.string().optional(),
      done: z.boolean().default(false),
    },
    async (args) => {
      try {
        const body: Json = { ...args, done: args.done ? 1 : 0 };
        return ok(await pd("POST", "/activities", { body }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "add_note",
    "Add a free-text note, attached to a deal_id and/or person_id.",
    {
      content: z.string().min(1),
      deal_id: z.number().int().optional(),
      person_id: z.number().int().optional(),
    },
    async (args) => {
      try {
        return ok(await pd("POST", "/notes", { body: args }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}

/* -------------------------------------------------------------------------- */
/* HTTP layer — stateless Streamable HTTP (one transport per request)         */
/* -------------------------------------------------------------------------- */

const app = express();
app.use(express.json({ limit: "4mb" }));

// Health check (handy for the host's uptime probes).
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

const MCP_PATH = `/mcp/${PATH_SECRET}`;

app.post(MCP_PATH, async (req: Request, res: Response) => {
  // Fresh server + transport per request keeps things stateless and simple,
  // which is the easiest mode for a remote connector to consume.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// In stateless mode GET (SSE stream) and DELETE (session teardown) aren't used.
const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)." },
    id: null,
  });
app.get(MCP_PATH, methodNotAllowed);
app.delete(MCP_PATH, methodNotAllowed);

app.listen(PORT, () => {
  console.log(`Pipedrive MCP server listening on :${PORT}`);
  console.log(`MCP endpoint path: ${MCP_PATH}`);
  console.log(`Pipedrive base URL: ${BASE_URL}`);
});

// Reference randomUUID so an unused-import lint never trips during deploys.
void randomUUID;
