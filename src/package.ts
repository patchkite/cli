import { isIgnoredPath, listFilesRecursive, packageHashFromPath } from "./core/hash.js";
import { SIGNATURE_FILE_NAME } from "./core/types.js";
import { createPrivateKey } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { importPKCS8, SignJWT } from "jose";
import yazl from "yazl";

export async function makeTempDir(prefix = "patchkite-") {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/**
 * Sign a package: an RS256 JWT containing `contentHash`,
 * stored as a `.patchkiterelease` file at the package root.
 */
export async function signPackage(dir: string, privateKeyPath: string) {
  const { hash } = await packageHashFromPath(dir);
  const pem = await readFile(privateKeyPath, "utf8");
  const key = await importPKCS8(pem.includes("BEGIN RSA PRIVATE KEY") ? convertPkcs1(pem) : pem, "RS256");
  const jwt = await new SignJWT({ claimVersion: "1.0.0", contentHash: hash })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt()
    .sign(key);
  await writeFile(path.join(dir, SIGNATURE_FILE_NAME), jwt);
  return hash;
}

function convertPkcs1(pem: string): string {
  return createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
}

/** Zip the contents of a directory (or a single file) into a new zip. */
export async function zipPath(target: string): Promise<{ zipFile: string; size: number }> {
  const zip = new yazl.ZipFile();
  const s = await stat(target);
  if (s.isFile()) zip.addFile(target, path.basename(target));
  else {
    for (const rel of (await listFilesRecursive(target)).sort()) {
      if (isIgnoredPath(rel) && !rel.endsWith(SIGNATURE_FILE_NAME)) continue;
      zip.addFile(path.join(target, rel), rel);
    }
  }
  const out = path.join(await makeTempDir(), "package.zip");
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(out)).on("close", resolve).on("error", reject);
    zip.end();
  });
  return { zipFile: out, size: (await stat(out)).size };
}

/** Copy a single file into a new directory (so it can be signed). */
export async function stageSingleFile(file: string) {
  const dir = await makeTempDir();
  await mkdir(dir, { recursive: true });
  await copyFile(file, path.join(dir, path.basename(file)));
  return dir;
}
