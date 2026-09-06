import * as path from "path";
import Mocha = require("mocha");

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
  });

  mocha.addFile(path.resolve(__dirname, "extension.test.js"));
  mocha.addFile(path.resolve(__dirname, "entryContainment.test.js"));
  mocha.addFile(path.resolve(__dirname, "indexLifecycle.test.js"));
  mocha.addFile(path.resolve(__dirname, "media.test.js"));
  mocha.addFile(path.resolve(__dirname, "regexSearch.test.js"));

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}
