import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { buildSync } from "esbuild";

buildSync({
	entryPoints: ["src/cli.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	outfile: "dist/cli.js",
});

// Prepend shebang — esbuild strips it from source, and banner puts it after imports
const content = readFileSync("dist/cli.js", "utf-8");
const stripped = content.replace(/^#!.*\n/gm, "");
writeFileSync("dist/cli.js", `#!/usr/bin/env node\n${stripped}`);
chmodSync("dist/cli.js", 0o755);
