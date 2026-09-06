import * as assert from "assert";
import * as fs from "fs-extra";
import * as path from "path";
import * as vscode from "vscode";

async function activateExtension(): Promise<void> {
  const extension = vscode.extensions.getExtension("jsldvr.vscode-journal");
  assert.ok(extension, "Extension not found");
  await extension.activate();
  assert.strictEqual(extension.isActive, true);
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "acceptance workspace missing");
  return folder.uri.fsPath;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return predicate();
}

async function listMarkdown(dir: string): Promise<string[]> {
  if (!(await fs.pathExists(dir))) {
    return [];
  }
  const found: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listMarkdown(full)));
    } else if (entry.name.endsWith(".md")) {
      found.push(full);
    }
  }
  return found;
}

async function setBlogPath(value: string): Promise<void> {
  await vscode.workspace
    .getConfiguration("vsJournal")
    .update("blogPath", value, vscode.ConfigurationTarget.Workspace);
}

// Regression coverage for the index-lifecycle configuration race: after
// vsJournal.blogPath changes, a New Entry command must acquire the index
// for the new directory and write there -- never into the retired one.
suite("Index lifecycle: New Entry follows a blogPath change", function () {
  this.timeout(60000);

  const blogA = "lifecycle-blog-a";
  const blogB = "lifecycle-blog-b";
  let originalBlogPath: string | undefined;
  let originalShowInputBox: typeof vscode.window.showInputBox;
  let nextTitle = "";

  suiteSetup(async () => {
    await activateExtension();
    const root = workspaceRoot();
    originalBlogPath = vscode.workspace
      .getConfiguration("vsJournal")
      .get<string>("blogPath");
    originalShowInputBox = vscode.window.showInputBox;
    // Feed the New Entry title prompt without user interaction. This
    // stubs a test double in, it does not change the command's shape.
    (
      vscode.window as unknown as { showInputBox: unknown }
    ).showInputBox = async () => nextTitle;

    await fs.ensureDir(path.join(root, blogA, "entries"));
    await fs.ensureDir(path.join(root, blogB, "entries"));
  });

  suiteTeardown(async () => {
    (
      vscode.window as unknown as { showInputBox: unknown }
    ).showInputBox = originalShowInputBox;
    await setBlogPath(originalBlogPath ?? "./blog");
    const root = workspaceRoot();
    await fs.remove(path.join(root, blogA)).catch(() => undefined);
    await fs.remove(path.join(root, blogB)).catch(() => undefined);
  });

  test("entry and index use the current directory, not the retired one", async () => {
    const root = workspaceRoot();
    const entriesA = path.join(root, blogA, "entries");
    const entriesB = path.join(root, blogB, "entries");

    // Point the journal at directory A and let the index settle there.
    await setBlogPath(blogA);
    const readyA = await waitFor(
      () => fs.pathExists(path.join(entriesA, ".vs-journal", "index.sqlite3")),
      20000
    );
    assert.strictEqual(readyA, true, "index database not created under blog A");

    nextTitle = "Lifecycle Entry A";
    await vscode.commands.executeCommand("vsJournal.newEntry");
    const wroteA = await waitFor(
      async () => (await listMarkdown(entriesA)).length === 1,
      20000
    );
    assert.strictEqual(wroteA, true, "New Entry did not write under blog A");

    // Switch configuration to directory B.
    await setBlogPath(blogB);
    const readyB = await waitFor(
      () => fs.pathExists(path.join(entriesB, ".vs-journal", "index.sqlite3")),
      20000
    );
    assert.strictEqual(readyB, true, "index database not created under blog B");

    // A New Entry command acquiring its index after the change must use
    // directory B.
    nextTitle = "Lifecycle Entry B";
    await vscode.commands.executeCommand("vsJournal.newEntry");
    const wroteB = await waitFor(
      async () => (await listMarkdown(entriesB)).length === 1,
      20000
    );
    assert.strictEqual(wroteB, true, "New Entry did not write under blog B");

    const inB = await listMarkdown(entriesB);
    assert.strictEqual(inB.length, 1);
    assert.ok(
      inB[0].endsWith("lifecycle-entry-b.md"),
      `unexpected entry file under blog B: ${inB[0]}`
    );

    // The retired directory must be untouched by the post-change entry.
    const inA = await listMarkdown(entriesA);
    assert.deepStrictEqual(
      inA.map((file) => path.basename(file)),
      ["lifecycle-entry-a.md"],
      "a new entry leaked into the retired directory"
    );

    // The active index the editor sees also points at B: opening the
    // entry created under B by its blog-relative path resolves.
    await vscode.commands.executeCommand("vsJournal.rescanEntries");
    const stillOnlyA = await listMarkdown(entriesA);
    assert.strictEqual(
      stillOnlyA.length,
      1,
      "rescan after the change must not repopulate the retired directory"
    );
  });
});
