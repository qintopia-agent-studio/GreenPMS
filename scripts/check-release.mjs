import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const read = (path, rootDir = root) => readFileSync(resolve(rootDir, path), "utf8");

export function parseReleaseTag(value) {
  if (typeof value !== "string" || !TAG.test(value)) {
    throw new Error(`Release tag must match vX.Y.Z: ${value || "(missing)"}`);
  }
  return value.slice(1);
}

function tagFromEnvironment(environment) {
  const ref = environment.GITHUB_REF || "";
  return ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : undefined;
}

export function checkRelease({ rootDir = root, tag, environment = process.env } = {}) {
  const packageJson = JSON.parse(read("package.json", rootDir));
  const lock = JSON.parse(read("package-lock.json", rootDir));
  const { version } = packageJson;

  if (!SEMVER.test(version)) {
    throw new Error(`package.json version must be strict semver: ${version}`);
  }
  if (lock.version !== version) {
    throw new Error("Root package-lock version must match package.json");
  }
  if (lock.packages?.[""]?.version !== version) {
    throw new Error("Root workspace lock version must match package.json");
  }

  const environmentTag = tagFromEnvironment(environment);
  if (tag !== undefined && environmentTag !== undefined && tag !== environmentTag) {
    throw new Error(`Explicit tag ${tag} does not match GITHUB_REF tag ${environmentTag}`);
  }
  const effectiveTag = tag ?? environmentTag;
  if (effectiveTag !== undefined) {
    const tagVersion = parseReleaseTag(effectiveTag);
    if (tagVersion !== version) {
      throw new Error(`Git tag ${effectiveTag} must match package.json version v${version}`);
    }
  }

  const notes = read(`docs/releases/v${version}.md`, rootDir);
  if (!notes.startsWith(`# QinTopia PMS v${version}\n`)) {
    throw new Error("Release notes must name the current version");
  }
  for (const section of ["优化说明", "升级说明", "验证与已知问题", "回退说明"]) {
    const content = notes.split(`## ${section}\n`)[1]?.split(/\n## /)[0]?.trim();
    if (!content) {
      throw new Error(`Release notes require a nonempty ${section} section`);
    }
  }
  if (!read("CHANGELOG.md", rootDir).includes(`docs/releases/v${version}.md`)) {
    throw new Error("CHANGELOG must link the current release notes");
  }

  return { version, tag: effectiveTag ?? `v${version}` };
}

export function parseArguments(argumentsList = process.argv.slice(2)) {
  const tagIndex = argumentsList.indexOf("--tag");
  if (tagIndex === -1) return {};
  const tag = argumentsList[tagIndex + 1];
  if (!tag || tag.startsWith("--")) {
    throw new Error("--tag requires a vX.Y.Z value");
  }
  return { tag };
}

export function main({ argumentsList = process.argv.slice(2), environment = process.env } = {}) {
  const result = checkRelease({ ...parseArguments(argumentsList), environment });
  console.log(`Release ${result.tag}: metadata, optimization notes, upgrade notes and recovery notes verified.`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Release check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
