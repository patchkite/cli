import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { c } from "./ui.js";

export interface BundleOptions {
  platform: "ios" | "android";
  entryFile?: string;
  bundleName?: string;
  outputDir: string;
  development?: boolean;
  sourcemapOutput?: string;
  extraBundlerOptions?: string[];
  config?: string;
  /** Passed as `--minify`; omitted if extraBundlerOptions already sets it. */
  minify?: boolean;
  useHermes?: boolean;
  extraHermesFlags?: string[];
  gradleFile?: string;
  podFile?: string;
}

export function defaultBundleName(platform: "ios" | "android") {
  return platform === "ios" ? "main.jsbundle" : `index.${platform}.bundle`;
}

export function defaultEntryFile(platform: string) {
  for (const f of [`index.${platform}.js`, "index.js", "index.ts", "index.tsx"]) if (existsSync(f)) return f;
  throw new Error("Entry file not found. Use --entryFile.");
}

function run(cmd: string, args: string[]) {
  console.log(c.gray(`$ ${cmd} ${args.join(" ")}`));
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`Command failed: ${cmd} ${args[0]}`);
}

export function runReactNativeBundle(o: BundleOptions) {
  const cli = path.resolve("node_modules/react-native/cli.js");
  if (!existsSync(cli)) throw new Error("react-native not found. Run this from the root of a React Native project.");
  const bundleOutput = path.join(o.outputDir, o.bundleName!);
  const args = [
    cli,
    "bundle",
    "--assets-dest",
    o.outputDir,
    "--bundle-output",
    bundleOutput,
    "--dev",
    String(!!o.development),
    "--entry-file",
    o.entryFile!,
    "--platform",
    o.platform,
    ...(o.sourcemapOutput ? ["--sourcemap-output", o.sourcemapOutput] : []),
    ...(o.config ? ["--config", o.config] : []),
    ...(o.minify !== undefined && !o.extraBundlerOptions?.some((a) => a.startsWith("--minify")) ? ["--minify", String(o.minify)] : []),
    ...(o.extraBundlerOptions ?? []),
  ];
  run("node", args);
  return bundleOutput;
}

// ---------- Binary version detection ----------

export function detectAppVersion(platform: "ios" | "android", opts: { plistFile?: string; gradleFile?: string; buildConfigurationName?: string }): string {
  return platform === "ios" ? detectIosVersion(opts.plistFile) : detectAndroidVersion(opts.gradleFile);
}

function detectAndroidVersion(gradleFile = "android/app/build.gradle"): string {
  const candidates = [gradleFile, "android/app/build.gradle.kts"];
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new Error(`Unable to find ${gradleFile}. Use --targetBinaryVersion.`);
  const content = readFileSync(file, "utf8");
  const m = content.match(/versionName\s*=?\s*["']([^"']+)["']/);
  if (m) return m[1]!;
  const prop = content.match(/versionName\s*=?\s*(?:project\.)?([A-Za-z_][\w.]*)/);
  if (prop) {
    const props = existsSync("android/gradle.properties") ? readFileSync("android/gradle.properties", "utf8") : "";
    const key = prop[1]!.split(".").pop()!;
    const v = props.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
    if (v) return v[1]!.trim();
  }
  throw new Error("versionName not found in build.gradle. Use --targetBinaryVersion.");
}

function detectIosVersion(plistFile?: string): string {
  const iosDir = "ios";
  const plist =
    plistFile ??
    (existsSync(iosDir)
      ? readdirSync(iosDir, { recursive: true, encoding: "utf8" })
          .map((f) => path.join(iosDir, f))
          .find((f) => f.endsWith("Info.plist") && !f.includes("Pods") && !f.includes("Tests") && !f.includes("build"))
      : undefined);
  if (!plist || !existsSync(plist)) throw new Error("Info.plist not found. Use --plistFile or --targetBinaryVersion.");
  const content = readFileSync(plist, "utf8");
  const m = content.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
  if (!m) throw new Error("CFBundleShortVersionString not found in Info.plist");
  let version = m[1]!.trim();
  if (version.includes("$(MARKETING_VERSION)")) {
    const pbx = readdirSync(iosDir)
      .filter((f) => f.endsWith(".xcodeproj"))
      .map((f) => path.join(iosDir, f, "project.pbxproj"))
      .find((f) => existsSync(f));
    const mv = pbx && readFileSync(pbx, "utf8").match(/MARKETING_VERSION = ([^;]+);/);
    if (!mv) throw new Error("MARKETING_VERSION not found in project.pbxproj");
    version = mv[1]!.trim();
  }
  return version;
}

// ---------- Hermes ----------

export function isHermesEnabled(platform: "ios" | "android", opts: { gradleFile?: string; podFile?: string }): boolean {
  if (platform === "android") {
    const props = existsSync("android/gradle.properties") ? readFileSync("android/gradle.properties", "utf8") : "";
    const m = props.match(/^hermesEnabled\s*=\s*(true|false)/m);
    if (m) return m[1] === "true";
    const gradle = opts.gradleFile && existsSync(opts.gradleFile) ? readFileSync(opts.gradleFile, "utf8") : "";
    return !/enableHermes\s*:\s*false/.test(gradle);
  }
  const podfile = opts.podFile ?? "ios/Podfile";
  const content = existsSync(podfile) ? readFileSync(podfile, "utf8") : "";
  // Hermes is enabled by default since RN 0.70
  return !/:hermes_enabled\s*=>\s*false/.test(content);
}

function findHermesc(): string {
  const osDir = process.platform === "darwin" ? "osx-bin" : process.platform === "win32" ? "win64-bin" : "linux64-bin";
  const exe = process.platform === "win32" ? "hermesc.exe" : "hermesc";
  const candidates = [
    `node_modules/hermes-compiler/hermesc/${osDir}/${exe}`,
    `node_modules/react-native/sdks/hermesc/${osDir}/${exe}`,
    `node_modules/hermes-engine/${osDir}/${exe}`,
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("hermesc not found. Make sure React Native dependencies are installed.");
  return path.resolve(found);
}

/** Compile the JS bundle to Hermes bytecode (replacing the same bundle file). */
export function runHermesCompile(bundlePath: string, sourcemapOutput?: string, extraFlags: string[] = []) {
  const hermesc = findHermesc();
  const hbc = `${bundlePath}.hbc`;
  // `-output-source-map` is always used, like Gradle/Xcode: debug info moves to a .map file,
  // so the bytecode is smaller and identical to the bundle in the binary (important for binary patches).
  run(hermesc, ["-emit-binary", "-out", hbc, bundlePath, "-O", "-w", "-output-source-map", ...extraFlags]);
  const compose = path.resolve("node_modules/react-native/scripts/compose-source-maps.js");
  if (sourcemapOutput && existsSync(compose) && existsSync(`${hbc}.map`)) {
    run("node", [compose, sourcemapOutput, `${hbc}.map`, "-o", sourcemapOutput]);
  }
  rmSync(`${hbc}.map`, { force: true });
  renameSync(hbc, bundlePath);
}
