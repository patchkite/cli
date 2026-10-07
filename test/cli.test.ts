import { describe, expect, it } from "vitest";
import { parseRollout } from "../src/commands/release.js";

describe("parseRollout", () => {
  it("accepts 1-100 with optional %", () => {
    expect(parseRollout("25")).toBe(25);
    expect(parseRollout("50%")).toBe(50);
    expect(parseRollout(undefined)).toBeUndefined();
  });
  it("rejects invalid values", () => {
    expect(() => parseRollout("0")).toThrow();
    expect(() => parseRollout("101")).toThrow();
    expect(() => parseRollout("abc")).toThrow();
  });
});

describe("version", () => {
  it("matches package.json", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const src = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(src).toContain(`.version("${pkg.version}")`);
  });
});
