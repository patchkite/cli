// Bundle the CLI into a single file with no workspace dependencies, then prepare the `release/`
// folder that is published to npm as @patchkite/cli.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFile, rm, mkdir, writeFile, copyFile, chmod } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const out = new URL("../release/", import.meta.url);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("patchkite.js", out)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  legalComments: "none",
  // CommonJS dependencies (commander, yauzl, ...) need `require` inside the ESM bundle.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});
// esbuild preserves the shebang from src/index.ts.
await chmod(new URL("patchkite.js", out), 0o755);

await writeFile(
  new URL("package.json", out),
  JSON.stringify(
    {
      name: "@patchkite/cli",
      version: pkg.version,
      description: pkg.description,
      type: "module",
      bin: { patchkite: "patchkite.js" },
      files: ["patchkite.js", "LICENSE"],
      engines: pkg.engines,
      repository: { type: "git", url: "https://github.com/patchkite/cli.git" },
      license: "MIT",
      homepage: pkg.homepage,
      bugs: { url: "https://github.com/patchkite/cli/issues" },
      publishConfig: { access: "public", provenance: true },
    },
    null,
    2,
  ) + "\n",
);
await copyFile(new URL("../README.md", import.meta.url), new URL("README.md", out));
await copyFile(new URL("../LICENSE", import.meta.url), new URL("LICENSE", out));
console.log(`release/ ready: @patchkite/cli@${pkg.version}`);
