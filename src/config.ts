import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface CliConfig {
  serverUrl: string;
  accessKey: string;
}

export const DEFAULT_SERVER_URL = "https://api.patchkite.com";
export const CONFIG_PATH = process.env.PATCHKITE_CONFIG_PATH ?? path.join(homedir(), ".patchkite.config");

export function readConfig(): CliConfig | null {
  const envKey = process.env.PATCHKITE_ACCESS_KEY;
  if (envKey) return { accessKey: envKey, serverUrl: process.env.PATCHKITE_SERVER_URL ?? DEFAULT_SERVER_URL };
  if (!existsSync(CONFIG_PATH)) return null;
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as CliConfig;
  if (process.env.PATCHKITE_SERVER_URL) cfg.serverUrl = process.env.PATCHKITE_SERVER_URL;
  return cfg;
}

export function writeConfig(cfg: CliConfig) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function deleteConfig() {
  rmSync(CONFIG_PATH, { force: true });
}
