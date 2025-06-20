import path from "node:path";
import fs from "node:fs/promises";
import { glob } from "tinyglobby";
// NOTE: `@ts-morph/bootstrap` is the most handy, but we should consider using `typescript` or `typescript-go`?
// `typescript` is not a peer dependency of `@ts-morph/bootstrap`, so its version is uncontrollable for us.
import { createProject, ts } from "@ts-morph/bootstrap";

// TODO: List all codes that OXC does not support!
// e.g. Type-only, module resolution, etc...
const DIAGNOSTIC_CODES_OXC_DOES_NOT_SUPPORT = new Set([
  2315, // Type 'U' is not generic.
  2322, // Type 'interfaceWithPublicAndOptional<number, string>' is not assignable to type '{ one: string; }'.
  2339, // Property 'protectedMethod' does not exist on type 'never'.
  2355, // A function whose declared type is neither 'undefined', 'void', nor 'any' must return a value.
  2403, // Subsequent variable declarations must have the same type.
  2416, // Property 'every' in type 'MyArray<T>' is not assignable to the same property in base type 'T[]'.
  2580, // Cannot find name 'module'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
  2589, // Type instantiation is excessively deep and possibly infinite.
  2792, // Cannot find module './file1'. Did you mean to set the 'moduleResolution' option to 'nodenext', or to add aliases to the 'paths' option?
  2872, // This kind of expression is always truthy.
  6053, // File '/declarations.d.ts' not found.
]);

// ---

console.log("🍀", "Reesolving environment variables and dependencies");
const ENABLE_DEBUG = process.env.DEBUG ? true : false;
const TS_REPO_DIR = process.env.TS_REPO_DIR ?? "./typescript";

const TEST_CATEGORIES = ["compiler", "conformance"];
const TYPESCRIPT_REPO_ROOT = path.resolve(TS_REPO_DIR);

// NOTE: Should be rewritten by ourselves?
const {
  TestCaseParser: { makeUnitsFromTest },
} = await import(`${TYPESCRIPT_REPO_ROOT}/src/harness/harnessIO`);
console.log("🍀", "Using TS version:", ts.version);

console.log("🍀", "Cleaning up previous test results");
await fs.rm("./fixtures", { recursive: true, force: true });
for (const testCategory of TEST_CATEGORIES) {
  await fs.mkdir(`./fixtures/${testCategory}/positive`, { recursive: true });
  await fs.mkdir(`./fixtures/${testCategory}/negative`, { recursive: true });
}

// TODO: Make it parallel!

const reports: Record<string, any> = {};
const supportedErrorDiagnostics = new Map<number, string>();
for (const testCategory of TEST_CATEGORIES) {
  const cwd = `${TYPESCRIPT_REPO_ROOT}/tests/cases/${testCategory}`;
  const testFileNames = await glob(`**/*`, { cwd });
  console.log(
    "🍀",
    `Processing test cases for "${testCategory}", ${testFileNames.length} items are found`,
  );

  const stats = {
    positive: 0,
    negative: 0,
  };
  for (const testFileName of testFileNames) {
    const testText = await fs.readFile(path.resolve(cwd, testFileName), "utf8");
    const testUnits = makeUnitsFromTest(testText, testFileName);

    debugLog(`${testFileName} - ${testUnits.testUnitData.length} unit(s)`);
    for (const {
      name: testUnitName,
      content: testUnitContent,
    } of testUnits.testUnitData) {
      if (!isSupportedTestUnit(testUnitName, testUnitContent)) {
        debugLog("💤", testUnitName);
        continue;
      }

      let diagnostics: ts.Diagnostic[] = [];
      try {
        diagnostics = await parseTypeScriptLikeOxc(
          testUnitName,
          testUnitContent,
        );
      } catch (_err) {
        const err = _err as Error;
        // NOTE: If `@types` options is used, TSC try to load it's type definitions!
        if (err.message.startsWith("Directory not found:")) continue;
        // TODO: これは例外処理しないとだめ？そもそもロードしないようにできない？
        // e.g. moduleResolution/resolutionModeTripleSlash1.ts
        // これ、関数の中に入れてもいい
        console.error("[parseTypeScriptLikeOxc()]", err.message);
        process.exit(1);
      }

      const errorDiagnosticsToBeSupported =
        extractErrorDiagnosticsToBeSupported(diagnostics);

      // Both `testFileName` and `testUnitName` may contain `/`, but we don't care, just flatten them
      const fixtureName = `${testFileName}/${testUnitName}`.replaceAll(
        "/",
        "___",
      );
      if (errorDiagnosticsToBeSupported.size === 0) {
        debugLog("✨", testUnitName);
        await fs.writeFile(
          `./fixtures/${testCategory}/positive/${fixtureName}`,
          testUnitContent,
        );
        stats.positive++;
      } else {
        debugErr("💥", testUnitName);
        await fs.writeFile(
          `./fixtures/${testCategory}/negative/${fixtureName}`,
          testUnitContent,
        );
        stats.negative++;

        for (const [code, message] of errorDiagnosticsToBeSupported)
          supportedErrorDiagnostics.set(code, message);
      }
    }
    debugLog();
  }

  reports[testCategory] = stats;
}
console.log("🍀", "Fixtures are written to `./fixtures`");
console.log(reports);

console.log(
  "🍀",
  `Writing supported ${supportedErrorDiagnostics.size} error diagnostics`,
);
// TODO: Save supportted codes and log it for future update
console.log("```js");
for (const [code, message] of Array.from(supportedErrorDiagnostics).sort(
  ([a], [b]) => a - b,
))
  console.log(`${code}, // ${message}`);
console.log("```");

// ---

function isSupportedTestUnit(fileName: string, fileContent: string) {
  // This is `undefined` if multiple `@filename` are used...
  if (typeof fileContent !== "string") return false;
  if (fileContent.trim() === "") return false;

  // Skip if the test unit is not a TypeScript-like file
  if (fileName.endsWith(".d.ts")) return false;
  if (
    ![".js", ".ts", ".cts", ".mts", ".cjs", ".mjs", ".jsx", ".tsx"].some(
      (ext) => fileName.endsWith(ext),
    )
  )
    return false;

  return true;
}

async function parseTypeScriptLikeOxc(testUnitName: string, code: string) {
  const ext = path.extname(testUnitName);

  const project = await createProject({
    useInMemoryFileSystem: true,
    // TODO: Consider other options later for faster parsing
    compilerOptions: {
      // OXC has no option equivalent, always parses the latest syntax
      target: ts.ScriptTarget.ESNext,
      jsx: ext.endsWith("x") ? ts.JsxEmit.Preserve : ts.JsxEmit.None,
      // TODO: Add more options...?
    },
  });

  project.createSourceFile(`dummy${ext}`, code);
  const program = project.createProgram();

  // `ts.getPreEmitDiagnostics()` contains more diagnotics, but we do not need them
  const allDiagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];

  return allDiagnostics;
}

function extractErrorDiagnosticsToBeSupported(diagnostics: ts.Diagnostic[]) {
  const errorDiagnosticsToBeSupported = new Map<number, string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    if (DIAGNOSTIC_CODES_OXC_DOES_NOT_SUPPORT.has(diagnostic.code)) continue;

    errorDiagnosticsToBeSupported.set(
      diagnostic.code,
      typeof diagnostic.messageText === "string"
        ? diagnostic.messageText
        : diagnostic.messageText.messageText,
    );
  }

  return errorDiagnosticsToBeSupported;
}

// ---

function debugLog(...args: any[]) {
  if (ENABLE_DEBUG) console.log(...args);
}
function debugErr(...args: any[]) {
  if (ENABLE_DEBUG) console.error(...args);
}
