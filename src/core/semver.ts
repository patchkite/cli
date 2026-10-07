import semver from "semver";

/** Validates a target binary version/range (e.g. "1.0.0", "1.2.x", "^1.2.3", "*"). */
export function isValidVersionRange(range: string): boolean {
  return semver.validRange(range) !== null;
}

/** "1.0" → "1.0.0" so native app versions can still be matched. */
export function normalizeAppVersion(version: string): string {
  const parts = version.trim().split("-")[0]!.split(".");
  while (parts.length < 3) parts.push("0");
  return parts.slice(0, 3).join(".");
}
