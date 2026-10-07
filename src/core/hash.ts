import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { SIGNATURE_FILE_NAME } from "./types.js";

// Package hash algorithm. Must stay byte-for-byte identical to the server and
// native SDKs; the shared test fixtures (test/fixtures) guard this.

/** Map of relative path ("/" separator) → sha256 hex of the file contents. */
export type Manifest = Record<string, string>;

const IGNORED = new Set([".DS_Store", "__MACOSX", SIGNATURE_FILE_NAME]);

export function isIgnoredPath(relativePath: string): boolean {
  return relativePath.split("/").some((seg) => IGNORED.has(seg));
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Package hash = sha256(JSON array of sorted "path:fileHash"), paths in Unicode NFC. */
export function packageHashFromManifest(manifest: Manifest): string {
  const entries = Object.keys(manifest)
    .filter((p) => !isIgnoredPath(p))
    // iOS writes file names as NFD, so non-ASCII names are normalized to NFC.
    .map((p) => [p.normalize("NFC"), manifest[p]] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, h]) => `${p}:${h}`);
  return sha256(JSON.stringify(entries));
}

export async function listFilesRecursive(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full, base)));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

async function manifestFromDirectory(dir: string): Promise<Manifest> {
  const manifest: Manifest = {};
  for (const rel of await listFilesRecursive(dir)) {
    if (isIgnoredPath(rel)) continue;
    manifest[rel] = await sha256File(path.join(dir, rel));
  }
  return manifest;
}

export async function packageHashFromPath(target: string): Promise<{ hash: string; manifest: Manifest }> {
  const s = await stat(target);
  const manifest = s.isFile() ? { [path.basename(target)]: await sha256File(target) } : await manifestFromDirectory(target);
  return { hash: packageHashFromManifest(manifest), manifest };
}
