import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

/**
 * Extract the built-in JS bundle from a store build artifact, to register it as the binary patch base.
 * - APK: assets/<bundle>
 * - AAB: base/assets/<bundle>
 * - IPA: Payload/<App>.app/<bundle>
 * Any other file is treated as the bundle itself.
 */
export async function extractBinaryBundle(artifact: string, bundleName: string, outDir: string): Promise<string> {
  const ext = path.extname(artifact).toLowerCase();
  if (![".apk", ".aab", ".ipa"].includes(ext)) return artifact;
  const wanted =
    ext === ".ipa"
      ? (name: string) => /^Payload\/[^/]+\.app\/[^/]+$/.test(name) && name.endsWith(`/${bundleName}`)
      : (name: string) => name === `assets/${bundleName}` || name === `base/assets/${bundleName}`;

  const out = path.join(outDir, bundleName);
  const found = await new Promise<boolean>((resolve, reject) => {
    yauzl.open(artifact, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("Artifact is not a valid zip"));
      zip.on("entry", (entry: yauzl.Entry) => {
        if (!wanted(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          pipeline(stream, createWriteStream(out)).then(() => {
            zip.close();
            resolve(true);
          }, reject);
        });
      });
      zip.on("end", () => resolve(false));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
  if (!found) {
    throw new Error(`${bundleName} not found in ${path.basename(artifact)}. Make sure this is a release build (the JS bundle is embedded in the binary).`);
  }
  return out;
}
