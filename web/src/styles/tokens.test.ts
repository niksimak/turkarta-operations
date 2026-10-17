import { describe, expect, it } from "vitest";
import css from "./tokens.css?raw";
import tailwindConfig from "../../tailwind.config";

function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`missing ${selector}`);
  const open = source.indexOf("{", start);
  return source.slice(open + 1, source.indexOf("}", open));
}

function vars(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const light = vars(block(css, ":root"));
const dark = vars(block(css, '[data-theme="dark"]'));
const darkBeforeJs = vars(block(css, ":root:not([data-theme])"));

describe("tokens.css", () => {
  it("keeps the OS-fallback dark set identical to the data-theme dark set", () => {
    expect(darkBeforeJs).toEqual(dark);
  });

  it("defines every dark colour in light too", () => {
    for (const name of dark.keys()) expect(light.has(name), name).toBe(true);
  });

  it("backs every Tailwind colour with a token defined in both themes", () => {
    const colors = tailwindConfig.theme.colors as Record<string, string>;
    for (const value of Object.values(colors)) {
      const name = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
      if (!name) continue;
      expect(light.has(name), name).toBe(true);
      expect(dark.has(name), name).toBe(true);
    }
  });

  it("has the semantic names later views rely on", () => {
    const required = ["--bg", "--surface", "--surface-2", "--border", "--text", "--text-muted", "--accent",
      "--sla-ok", "--sla-warn", "--sla-late", "--note-bg", "--danger", "--ch-bot", "--ch-miniapp", "--ch-web"];
    for (const name of required) expect(dark.has(name) && light.has(name), name).toBe(true);
  });
});
