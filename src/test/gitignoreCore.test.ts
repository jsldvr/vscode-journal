import * as assert from "assert";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  GITIGNORE_RULE,
  appendGitignoreRule,
  gitignoreCoversGeneratedDir,
} from "../gitignoreCore";

suite("gitignoreCore", () => {
  test("recognizes existing rules that cover the generated directory", () => {
    assert.strictEqual(gitignoreCoversGeneratedDir(".vs-journal/"), true);
    assert.strictEqual(gitignoreCoversGeneratedDir("**/.vs-journal/"), true);
    assert.strictEqual(
      gitignoreCoversGeneratedDir("node_modules/\n  .vs-journal  \nout/"),
      true
    );
    assert.strictEqual(
      gitignoreCoversGeneratedDir("# .vs-journal/ (comment only)"),
      false
    );
    assert.strictEqual(gitignoreCoversGeneratedDir("vs-journal/"), false);
    assert.strictEqual(gitignoreCoversGeneratedDir(""), false);
  });

  test("appendGitignoreRule appends once and never duplicates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vs-journal-gi-"));
    const gitignorePath = path.join(dir, ".gitignore");
    try {
      await fs.writeFile(gitignorePath, "node_modules/");
      await appendGitignoreRule(gitignorePath);
      await appendGitignoreRule(gitignorePath);
      const content = await fs.readFile(gitignorePath, "utf8");
      assert.strictEqual(content, `node_modules/\n${GITIGNORE_RULE}\n`);
    } finally {
      await fs.remove(dir);
    }
  });

  test("appendGitignoreRule creates the file when missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vs-journal-gi-"));
    const gitignorePath = path.join(dir, ".gitignore");
    try {
      await appendGitignoreRule(gitignorePath);
      const content = await fs.readFile(gitignorePath, "utf8");
      assert.strictEqual(content, `${GITIGNORE_RULE}\n`);
    } finally {
      await fs.remove(dir);
    }
  });
});
