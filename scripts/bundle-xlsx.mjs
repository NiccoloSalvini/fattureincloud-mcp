// Inlines SheetJS into dist/bank/parse.js. SheetJS is distributed from its own CDN,
// and recent npm versions refuse remote tarball dependencies, so the published
// package must not depend on it at runtime.
import { build } from "esbuild";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
await build({
  entryPoints: [path.join(root, "src/bank/parse.ts")],
  outfile: path.join(root, "dist/bank/parse.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  legalComments: "eof",
  logLevel: "warning",
});
