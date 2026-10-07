import { isValidVersionRange, normalizeAppVersion } from "../core/semver.js";
import type { Package, Platform } from "../core/types.js";
import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PatchkiteApi, ApiError } from "../api.js";
import {
  buildFlutterApk,
  DEFAULT_FLUTTER_ABIS,
  detectFlutterAppVersion,
  detectFlutterEngineRevision,
  extractLibApp,
} from "../flutter.js";
import { makeTempDir, signPackage, stageSingleFile, zipPath } from "../package.js";
import {
  defaultBundleName,
  defaultEntryFile,
  detectAppVersion,
  isHermesEnabled,
  runHermesCompile,
  runReactNativeBundle,
} from "../react-native.js";
import { c, formatSize } from "../ui.js";

export interface CommonReleaseOptions {
  deploymentName: string;
  description?: string;
  mandatory?: boolean;
  disabled?: boolean;
  rollout?: string;
  privateKeyPath?: string;
  noDuplicateReleaseError?: boolean;
}

export function parseRollout(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(String(value).replace("%", ""));
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("Rollout must be an integer between 1 and 100");
  return n;
}

async function assertAppPlatform(api: PatchkiteApi, appName: string, platform: Platform) {
  const app = await api.getApp(appName);
  if (app.platform !== platform) {
    throw new Error(`App "${appName}" is registered as a ${app.platform} app, not ${platform}.`);
  }
  return app;
}

/** Upload a package (directory/file). */
export async function releasePath(
  api: PatchkiteApi,
  appName: string,
  contentPath: string,
  targetBinaryVersion: string,
  opts: CommonReleaseOptions & { engineRevision?: string },
): Promise<Package | null> {
  if (!isValidVersionRange(targetBinaryVersion)) {
    throw new Error(`Invalid target binary version "${targetBinaryVersion}". Use a semver range, e.g. 1.0.0, 1.0.x, ^1.2.3.`);
  }
  if (!existsSync(contentPath)) throw new Error(`Path "${contentPath}" not found`);
  const rollout = parseRollout(opts.rollout);

  let dir = contentPath;
  if ((await stat(contentPath)).isFile()) dir = await stageSingleFile(contentPath);
  if (opts.privateKeyPath) {
    await signPackage(dir, opts.privateKeyPath);
    console.log(c.gray("Package signed (code signing)."));
  }
  const { zipFile, size } = await zipPath(dir);
  console.log(c.gray(`Uploading package (${formatSize(size)}) to the "${opts.deploymentName}" deployment...`));
  try {
    const pkg = await api.release(appName, opts.deploymentName, zipFile, {
      appVersion: targetBinaryVersion,
      description: opts.description ?? "",
      isMandatory: !!opts.mandatory,
      isDisabled: !!opts.disabled,
      rollout: rollout ?? null,
      engineRevision: opts.engineRevision ?? null,
    });
    console.log(
      c.green(
        `Successfully released an update containing the "${contentPath}" ${dir === contentPath ? "directory" : "file"} to the "${opts.deploymentName}" deployment of the "${appName}" app (${pkg.label}).`,
      ),
    );
    return pkg;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && opts.noDuplicateReleaseError && /identical/.test(e.message)) {
      console.log(c.yellow(`[Warning] ${e.message}`));
      return null;
    }
    throw e;
  } finally {
    await rm(path.dirname(zipFile), { recursive: true, force: true });
  }
}

export interface ReleaseReactOptions extends CommonReleaseOptions {
  targetBinaryVersion?: string;
  bundleName?: string;
  entryFile?: string;
  development?: boolean;
  outputDir?: string;
  sourcemapOutput?: string;
  sourcemapOutputDir?: string;
  gradleFile?: string;
  plistFile?: string;
  podFile?: string;
  config?: string;
  useHermes?: boolean;
  extraHermesFlags?: string[];
  extraBundlerOptions?: string[];
}

/** Bundle the React Native JS, then release it. */
export async function releaseReact(api: PatchkiteApi, appName: string, platform: string, opts: ReleaseReactOptions) {
  const os = platform.toLowerCase();
  if (os !== "ios" && os !== "android") throw new Error('Platform must be "ios" or "android"');
  const app = await assertAppPlatform(api, appName, "react-native");
  if (app.os !== os) throw new Error(`App "${appName}" is registered for ${app.os}, not ${os}.`);
  if (!existsSync("package.json")) throw new Error("Run this command from the root of a React Native project.");

  const targetBinaryVersion = opts.targetBinaryVersion ?? detectAppVersion(os, opts);
  const outputDir = opts.outputDir ?? path.join(await makeTempDir(), "Patchkite");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const bundleName = opts.bundleName ?? defaultBundleName(os);
  const sourcemapOutput =
    opts.sourcemapOutput ?? (opts.sourcemapOutputDir ? path.join(opts.sourcemapOutputDir, `${bundleName}.map`) : undefined);
  const hermes = opts.useHermes ?? isHermesEnabled(os, { gradleFile: opts.gradleFile, podFile: opts.podFile });
  console.log(c.cyan(`Running "react-native bundle" command:`));
  const bundlePath = runReactNativeBundle({
    platform: os,
    bundleName,
    entryFile: opts.entryFile ?? defaultEntryFile(os),
    outputDir,
    development: opts.development,
    sourcemapOutput,
    config: opts.config,
    extraBundlerOptions: opts.extraBundlerOptions,
    // Same as Gradle/Xcode: with Hermes, Metro does not minify (Hermes does the optimizing).
    // That way the update bundle is identical to the bundle in the binary when the code is the same.
    minify: !hermes,
  });

  if (hermes) {
    console.log(c.cyan("Converting JS bundle to Hermes bytecode..."));
    runHermesCompile(bundlePath, sourcemapOutput, opts.extraHermesFlags);
  }

  console.log(c.cyan(`Releasing update contents to Patchkite (target binary ${targetBinaryVersion}):`));
  try {
    return await releasePath(api, appName, outputDir, targetBinaryVersion, opts);
  } finally {
    if (!opts.outputDir) await rm(path.dirname(outputDir), { recursive: true, force: true });
  }
}

export interface ReleaseFlutterOptions extends CommonReleaseOptions {
  targetBinaryVersion?: string;
  targetAbis?: string;
  buildArgs?: string[];
  flutterPath?: string;
  apk?: string;
}

/**
 * Build a release Flutter APK, then upload `libapp.so` (AOT Dart code) per ABI.
 * Updates are only offered to binaries with the same Flutter engine revision.
 */
export async function releaseFlutter(api: PatchkiteApi, appName: string, platform: string, opts: ReleaseFlutterOptions) {
  if (platform.toLowerCase() !== "android") {
    throw new Error("Flutter OTA updates currently support Android only (iOS forbids dynamically loading native code).");
  }
  const app = await assertAppPlatform(api, appName, "flutter");
  if (app.os !== "android") throw new Error(`App "${appName}" is registered for ${app.os}, not android.`);

  const flutter = opts.flutterPath ?? "flutter";
  const abis = opts.targetAbis ? opts.targetAbis.split(",").map((s) => s.trim()) : DEFAULT_FLUTTER_ABIS;
  const targetBinaryVersion = opts.targetBinaryVersion ?? normalizeAppVersion(detectFlutterAppVersion());
  const engineRevision = detectFlutterEngineRevision(flutter);
  const apk = opts.apk ?? buildFlutterApk(abis, opts.buildArgs ?? [], flutter);

  const outputDir = await makeTempDir();
  try {
    const extracted = await extractLibApp(apk, outputDir, abis);
    console.log(c.gray(`Found libapp.so for ABIs: ${extracted.join(", ")} (engine ${engineRevision.slice(0, 10)})`));
    return await releasePath(api, appName, outputDir, targetBinaryVersion, { ...opts, engineRevision });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
