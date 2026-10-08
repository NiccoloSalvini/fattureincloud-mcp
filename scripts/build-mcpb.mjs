// Builds dist/ and packs a Claude Desktop extension (.mcpb) with production deps only.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const stage = path.join(root, "build", "mcpb");
const out = path.join(root, "build", `fattureincloud-mcp-${pkg.version}.mcpb`);
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

run("npx", ["tsc"]);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ["dist", "README.md", "LICENSE", "package.json", "package-lock.json"]) cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
rmSync(out, { force: true });
run("npx", ["-y", "@anthropic-ai/mcpb", "pack", stage, out]);
console.log(`\n${out}`);
