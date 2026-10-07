import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { c } from "./ui.js";

export const DEFAULT_FLUTTER_ABIS = ["arm64-v8a", "armeabi-v7a", "x86_64"];
const ABI_TO_TARGET: Record<string, string> = {
  "arm64-v8a": "android-arm64",
  "armeabi-v7a": "android-arm",
  x86_64: "android-x64",
};

export function detectFlutterAppVersion(): string {
  if (!existsSync("pubspec.yaml")) throw new Error("pubspec.yaml not found. Run this from the root of a Flutter project.");
  const m = readFileSync("pubspec.yaml", "utf8").match(/^version:\s*([^\s+#]+)/m);
  if (!m) throw new Error("No `version` field in pubspec.yaml. Use --targetBinaryVersion.");
  return m[1]!;
}

/** The engine revision determines whether libapp.so is compatible with the installed binary. */
export function detectFlutterEngineRevision(flutterCmd = "flutter"): string {
  const res = spawnSync(flutterCmd, ["--version", "--machine"], { encoding: "utf8" });
  if (res.status !== 0) throw new Error("Failed to run `flutter --version`.");
  const json = JSON.parse(res.stdout.slice(res.stdout.indexOf("{")));
  return json.engineRevision as string;
}

export function buildFlutterApk(abis: string[], extraArgs: string[], flutterCmd = "flutter") {
  const targets = abis.map((a) => ABI_TO_TARGET[a]).filter(Boolean);
  const args = ["build", "apk", "--release", `--target-platform=${targets.join(",")}`, ...extraArgs];
  console.log(c.gray(`$ ${flutterCmd} ${args.join(" ")}`));
  const res = spawnSync(flutterCmd, args, { stdio: "inherit" });
  if (res.status !== 0) throw new Error("flutter build apk failed");
  const apk = path.resolve("build/app/outputs/flutter-apk/app-release.apk");
  if (!existsSync(apk)) throw new Error(`APK not found at ${apk}`);
  return apk;
}

/** Extract `lib/<abi>/libapp.so` from the APK into `outDir/lib/<abi>/libapp.so`. */
export function extractLibApp(apk: string, outDir: string, abis: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const found: string[] = [];
    yauzl.open(apk, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      zip.on("entry", (entry: yauzl.Entry) => {
        const m = entry.fileName.match(/^lib\/([^/]+)\/libapp\.so$/);
        if (!m || !abis.includes(m[1]!)) return zip.readEntry();
        const dest = path.join(outDir, entry.fileName);
        mkdir(path.dirname(dest), { recursive: true }).then(() =>
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return reject(e);
            stream
              .pipe(createWriteStream(dest))
              .on("close", () => {
                found.push(m[1]!);
                zip.readEntry();
              })
              .on("error", reject);
          }),
        );
      });
      zip.on("end", () => (found.length ? resolve(found) : reject(new Error("libapp.so not found in the APK"))));
      zip.readEntry();
    });
  });
}
