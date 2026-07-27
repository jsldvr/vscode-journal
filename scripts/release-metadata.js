"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(version) {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new Error(`Invalid semantic version in package.json: ${version}`);
  }
  return {
    version,
    prerelease: match[4] !== undefined,
  };
}

function extractChangelogSection(changelog, version) {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(
    `^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`,
    "m"
  );
  const match = heading.exec(changelog);
  if (!match) {
    throw new Error(`CHANGELOG.md has no dated section for ${version}`);
  }

  const contentStart = match.index + match[0].length;
  const nextHeading = /^## \[/gm;
  nextHeading.lastIndex = contentStart;
  const nextMatch = nextHeading.exec(changelog);
  const contentEnd = nextMatch ? nextMatch.index : changelog.length;
  const content = changelog
    .slice(contentStart, contentEnd)
    .replace(/\r\n/g, "\n")
    .trim();
  if (!content) {
    throw new Error(`CHANGELOG.md section for ${version} is empty`);
  }
  return content;
}

function contributorDisplayName(name, email) {
  const githubEmail = /^(?:\d+\+)?([^+@]+)@users\.noreply\.github\.com$/i.exec(
    email
  );
  return githubEmail ? `@${githubEmail[1]}` : name;
}

function contributorsFromLog(log) {
  const contributors = new Map();
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [name = "", email = ""] = line.split("\t");
    const displayName = contributorDisplayName(name.trim(), email.trim());
    if (
      !displayName ||
      /\[bot\]|\bbot\b|github-actions/i.test(`${displayName} ${email}`)
    ) {
      continue;
    }
    contributors.set(displayName.toLowerCase(), displayName);
  }
  return Array.from(contributors.values()).sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "base" })
  );
}

function buildReleaseBody(changelogSection, contributors) {
  const contributorLines =
    contributors.length > 0
      ? contributors.map((contributor) => `- ${contributor}`)
      : ["- No contributors found"];
  return `${changelogSection}\n\n## Contributors\n\n${contributorLines.join("\n")}\n`;
}

function findPreviousTag(currentTag, git = execFileSync) {
  const output = git(
    "git",
    ["tag", "--merged", "HEAD", "--list", "v*", "--sort=-version:refname"],
    { encoding: "utf8" }
  );
  for (const tag of output.split(/\r?\n/).filter(Boolean)) {
    if (tag === currentTag || !tag.startsWith("v")) {
      continue;
    }
    try {
      parseSemver(tag.slice(1));
      return tag;
    } catch {
      // Ignore tags that are not release SemVer tags.
    }
  }
  return undefined;
}

function generateReleaseMetadata({
  packageJson,
  changelog,
  contributorLog,
  previousTag,
}) {
  const parsed = parseSemver(packageJson.version);
  const tag = `v${parsed.version}`;
  const contributors = contributorsFromLog(contributorLog);
  return {
    version: parsed.version,
    tag,
    title: `Release ${tag}`,
    prerelease: parsed.prerelease,
    previousTag,
    contributors,
    body: buildReleaseBody(
      extractChangelogSection(changelog, parsed.version),
      contributors
    ),
  };
}

function parseArguments(argumentsList) {
  const result = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error(`Invalid argument near ${name || "<end>"}`);
    }
    result[name.slice(2)] = value;
  }
  if (!result["output-dir"]) {
    throw new Error("--output-dir is required");
  }
  return result;
}

function runCli() {
  const args = parseArguments(process.argv.slice(2));
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
  const tag = `v${parseSemver(packageJson.version).version}`;
  const previousTag = findPreviousTag(tag);
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const contributorLog = execFileSync(
    "git",
    ["log", range, "--format=%aN%x09%aE"],
    { encoding: "utf8" }
  );
  const metadata = generateReleaseMetadata({
    packageJson,
    changelog,
    contributorLog,
    previousTag,
  });

  const outputDir = path.resolve(args["output-dir"]);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`
  );
  fs.writeFileSync(path.join(outputDir, "release-notes.md"), metadata.body);

  if (args["github-output"]) {
    const outputLines = [
      `version=${metadata.version}`,
      `tag=${metadata.tag}`,
      `title=${metadata.title}`,
      `prerelease=${metadata.prerelease}`,
      `previous_tag=${metadata.previousTag || ""}`,
    ];
    fs.appendFileSync(args["github-output"], `${outputLines.join("\n")}\n`);
  }
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  buildReleaseBody,
  contributorsFromLog,
  extractChangelogSection,
  findPreviousTag,
  generateReleaseMetadata,
  parseSemver,
};
