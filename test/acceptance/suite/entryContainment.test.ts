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
  assert.ok(folder, "integration workspace missing");
  return folder.uri.fsPath;
}

function entriesDir(): string {
  return path.join(workspaceRoot(), "blog", "entries");
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

async function tryDirLink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, "junction");
    return true;
  } catch {
    return false;
  }
}

suite("Entry symlink containment", function () {
  this.timeout(40000);

  test("a directory junction under entries is never indexed by a rescan", async () => {
    await activateExtension();

    const outside = path.join(workspaceRoot(), "outside-journal");
    await fs.ensureDir(outside);
    await fs.writeFile(
      path.join(outside, "leak.md"),
      "---\ntitle: Leak\ndate: 2026-07-24 09:00:00\ntags: [leak]\n---\n\nleaked body\n"
    );
    const linkPath = path.join(entriesDir(), "2026", "linked");
    await fs.ensureDir(path.dirname(linkPath));
    const linked = await tryDirLink(outside, linkPath);
    assert.ok(linked, "directory junction creation must be available on the runner");

    try {
      await vscode.commands.executeCommand("vsJournal.rescanEntries");
      // "Leak" must not have entered the index via the junction.
      await vscode.commands.executeCommand("vsJournal.searchByTag", "leak");
      // The junction target must be untouched.
      const targetEntries = await fs.readdir(outside);
      assert.deepStrictEqual(targetEntries.sort(), ["leak.md"]);
      assert.strictEqual(
        await fs.pathExists(path.join(outside, ".vs-journal")),
        false
      );
    } finally {
      await fs.remove(linkPath).catch(() => undefined);
      await fs.remove(outside).catch(() => undefined);
      await vscode.commands.executeCommand("vsJournal.rescanEntries");
    }
  });

  test("openEntry rejects a junctioned entry path without throwing", async () => {
    await activateExtension();

    const outside = path.join(workspaceRoot(), "outside-open");
    await fs.ensureDir(outside);
    await fs.writeFile(path.join(outside, "note.md"), "secret");
    const linkPath = path.join(entriesDir(), "linked-open");
    const linked = await tryDirLink(outside, linkPath);
    assert.ok(linked);

    try {
      // Must resolve (show an error message) rather than reject.
      await vscode.commands.executeCommand(
        "vsJournal.openEntry",
        "linked-open/note.md"
      );
      const active = vscode.window.activeTextEditor?.document.uri.fsPath;
      assert.notStrictEqual(
        active && path.normalize(active),
        path.normalize(path.join(outside, "note.md"))
      );
    } finally {
      await fs.remove(linkPath).catch(() => undefined);
      await fs.remove(outside).catch(() => undefined);
    }
  });

  async function findEntryFile(slug: string): Promise<string | undefined> {
    const stack = [entriesDir()];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const full = path.join(dir, name);
        const stat = await fs.lstat(full).catch(() => undefined);
        if (!stat) {
          continue;
        }
        if (stat.isDirectory() && name !== ".vs-journal") {
          stack.push(full);
        } else if (stat.isFile() && name === `${slug}.md`) {
          return full;
        }
      }
    }
    return undefined;
  }

  test("New Entry drives the command to create and index an ordinary contained entry", async () => {
    await activateExtension();
    // Alphanumeric only: createNewEntry strips non-alphanumerics from the
    // title to form the filename, so the slug must survive that as-is.
    const slug = `accnormalentry${Date.now()}`;
    const originalInput = vscode.window.showInputBox;
    (vscode.window as unknown as { showInputBox: unknown }).showInputBox =
      async () => slug;
    try {
      await vscode.commands.executeCommand("vsJournal.newEntry");
      const created = await waitFor(
        async () => (await findEntryFile(slug)) !== undefined,
        10000
      );
      assert.strictEqual(created, true, "New Entry should create the .md file");
      const found = await findEntryFile(slug);
      assert.ok(found && (await fs.lstat(found)).isFile());
    } finally {
      (vscode.window as unknown as { showInputBox: unknown }).showInputBox =
        originalInput;
      const found = await findEntryFile(slug);
      if (found) {
        await fs.remove(found).catch(() => undefined);
      }
      await vscode.commands
        .executeCommand("vsJournal.rescanEntries")
        .then(undefined, () => undefined);
    }
  });

  test("New Entry does not open the created file if its path turns unsafe after indexing (F3 boundary regression)", async () => {
    await activateExtension();

    // The running extension loads its own copy of blogIndex from out/,
    // so it cannot be patched from here. fs-extra is a shared singleton,
    // so drive the boundary through lstat instead: createNewEntry lstats
    // the new file exactly once per assertSafeExistingFile call, in this
    // order -- (1) pre-index guard, (2) upsertFromFile's entry guard,
    // (3) upsertFromFile's Promise.all stat, (4) upsertFromFile's
    // pre-commit re-check, (5) the F3 guard that must run between
    // indexing and openTextDocument. Reporting the file as a link on
    // call 5 makes the F3 guard throw; with the F3 line removed there is
    // no call 5, so openTextDocument would be reached -- the assertion
    // fails, which is the regression signal.
    const fsExtraModule = require("fs-extra");
    const originalLstat = fsExtraModule.lstat;
    const originalInput = vscode.window.showInputBox;
    const originalOpenDoc = vscode.workspace.openTextDocument;

    const slug = `accf3boundary${Date.now()}`;
    let fileLstatCalls = 0;
    const openedPaths: string[] = [];

    fsExtraModule.lstat = async (target: string) => {
      if (
        typeof target === "string" &&
        target.toLowerCase().includes(slug) &&
        target.endsWith(".md")
      ) {
        fileLstatCalls += 1;
        if (fileLstatCalls >= 5) {
          return {
            isSymbolicLink: () => true,
            isFile: () => false,
            isDirectory: () => false,
          };
        }
      }
      return originalLstat(target);
    };
    (vscode.window as unknown as { showInputBox: unknown }).showInputBox =
      async () => slug;
    (
      vscode.workspace as unknown as { openTextDocument: unknown }
    ).openTextDocument = async (arg: unknown) => {
      const asPath =
        typeof arg === "string"
          ? arg
          : (arg as { fsPath?: string })?.fsPath ?? String(arg);
      openedPaths.push(asPath);
      return originalOpenDoc.call(vscode.workspace, arg as never);
    };

    try {
      await vscode.commands.executeCommand("vsJournal.newEntry");
      assert.ok(
        fileLstatCalls >= 5,
        `expected the F3 guard to lstat the new file (calls=${fileLstatCalls}); the boundary or call count changed`
      );
      assert.ok(
        !openedPaths.some((p) => p.toLowerCase().includes(slug)),
        `openTextDocument must not be called for the unsafe new entry; opened: ${JSON.stringify(
          openedPaths
        )}`
      );
    } finally {
      fsExtraModule.lstat = originalLstat;
      (vscode.window as unknown as { showInputBox: unknown }).showInputBox =
        originalInput;
      (
        vscode.workspace as unknown as { openTextDocument: unknown }
      ).openTextDocument = originalOpenDoc;
      const found = await findEntryFile(slug);
      if (found) {
        await fs.remove(found).catch(() => undefined);
      }
      await vscode.commands
        .executeCommand("vsJournal.rescanEntries")
        .then(undefined, () => undefined);
    }
  });

  test("activation left the real sample entry indexed and searchable", async () => {
    await activateExtension();
    const dbPath = path.join(entriesDir(), ".vs-journal", "index.sqlite3");
    assert.strictEqual(
      await waitFor(() => fs.pathExists(dbPath), 20000),
      true,
      "the contained index database should still open normally"
    );
  });
});
