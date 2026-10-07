import Table from "cli-table3";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { styleText } from "node:util";

export const c = {
  green: (s: string) => styleText("green", s),
  red: (s: string) => styleText("red", s),
  cyan: (s: string) => styleText("cyan", s),
  gray: (s: string) => styleText("gray", s),
  bold: (s: string) => styleText("bold", s),
  yellow: (s: string) => styleText("yellow", s),
};

export type OutputFormat = "table" | "json";

export function table(head: string[], rows: (string | number)[][]) {
  const t = new Table({ head: head.map((h) => c.cyan(h)), style: { head: [] }, wordWrap: true });
  t.push(...rows.map((r) => r.map(String)));
  console.log(t.toString());
}

export function success(msg: string) {
  console.log(c.green(`Successfully ${msg}`));
}

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Password input without echo. */
export async function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
  let asked = false;
  out._writeToOutput = (s: string) => {
    if (!asked) {
      out.output.write(s);
      asked = true;
    }
  };
  try {
    const answer = await rl.question(question);
    process.stdout.write("\n");
    return answer;
  } finally {
    rl.close();
  }
}

export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await prompt(`${question} (y/N): `));
}

export function openUrl(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

export function formatDate(ms: number) {
  return new Date(ms).toLocaleString();
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
