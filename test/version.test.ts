import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("every place that states the plugin version agrees", () => {
  const manifest = JSON.parse(read(".claude-plugin/plugin.json")).version;
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json")).plugins[0].version;
  const pkg = JSON.parse(read("package.json")).version;
  const server = /const SERVER_VERSION = "([^"]+)"/.exec(read("src/server.ts"))?.[1];
  expect({ marketplace, pkg, server }).toEqual({ marketplace: manifest, pkg: manifest, server: manifest });
});
