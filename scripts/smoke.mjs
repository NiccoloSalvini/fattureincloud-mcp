// Read-only smoke test against a real Fatture in Cloud account.
// Usage: node scripts/smoke.mjs [tool] [jsonArgs]
// With no arguments runs a fixed set of read-only tools and prints short summaries.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist/index.js")], env: { ...process.env } });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) return { error: text };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const [tool, json] = process.argv.slice(2);
if (tool) {
  console.log(JSON.stringify(await call(tool, json ? JSON.parse(json) : {}), null, 2));
} else {
  const steps = [
    ["list_companies", {}],
    ["list_issued_documents", { type: "invoice", per_page: 10, sort: "-date" }],
    ["audit_documents", {}],
    ["receivables_report", {}],
    ["revenue_summary", {}],
    ["schedule_list", {}],
    ["list_pending_received_documents", { source: "all" }],
    ["recurring_expenses_report", {}],
  ];
  for (const [name, args] of steps) {
    const r = await call(name, args);
    console.log(`\n=== ${name}`);
    console.log(JSON.stringify(r, null, 2).slice(0, 2500));
  }
}
await client.close();
