import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(resolve(root, path), "utf8");
const { version } = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.equal(lock.version, version, "Root package-lock version must match package.json");
assert.equal(lock.packages[""].version, version, "Root workspace lock version must match");
const notes = read(`docs/releases/v${version}.md`);
assert.ok(notes.startsWith(`# QinTopia PMS v${version}\n`), "Release notes must name the current version");
for (const section of ["优化说明", "升级说明", "验证与已知问题", "回退说明"]) {
  const content = notes.split(`## ${section}\n`)[1]?.split(/\n## /)[0]?.trim();
  assert.ok(content, `Release notes require a nonempty ${section} section`);
}
assert.ok(read("CHANGELOG.md").includes(`docs/releases/v${version}.md`), "CHANGELOG must link the current release notes");
console.log(`Release v${version}: metadata, optimization notes, upgrade notes and recovery notes verified.`);
