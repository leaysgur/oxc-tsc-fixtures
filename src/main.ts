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

const supportedErrorDiagnostics = new Map<number, string>();
for (const testCategory of TEST_CATEGORIES) {
  console.log("🍀", `Processing tests for "${testCategory}"`);

  const cwd = `${TYPESCRIPT_REPO_ROOT}/tests/cases/${testCategory}`;
  const testFileNames = await glob(`**/*`, { cwd });
  for (const testFileName of testFileNames) {
    const testText = await fs.readFile(path.resolve(cwd, testFileName), "utf8");
    const testUnits = makeUnitsFromTest(testText, testFileName);

    debugLog(`${testFileName} - ${testUnits.testUnitData.length} unit(s)`);
    for (const {
      name: testUnitName,
      content: testUnitContent,
    } of testUnits.testUnitData) {
      if (testUnitName.endsWith(".d.ts") || testUnitName.endsWith(".json")) {
        debugLog("🍃", testUnitName);
        continue;
      }
      debugAssert(
        [".js", ".ts", ".jsx", ".tsx"].some((ext) =>
          testUnitName.endsWith(ext),
        ),
        `Unexpected test unit extension: ${testUnitName}`,
      );

      let diagnostics: ts.Diagnostic[] = [];
      try {
        diagnostics = await parseTypeScriptLikeOxc(
          testUnitName,
          testUnitContent,
        );
      } catch (err) {
        // NOTE: If `@types` options is used, TSC try to load it's type definitions.
        // if (err.message.startsWith("Directory not found:")) continue;
        console.error("[parseTypeScriptLikeOxc()]", err.message);
        process.exit(1);
      }

      const errorDiagnosticsToBeSupported =
        extractErrorDiagnosticsToBeSupported(diagnostics);

      const fixtureName = `${testFileName}/${testUnitName}`.replaceAll(
        "/",
        "___",
      );
      if (errorDiagnosticsToBeSupported.size === 0) {
        await fs.writeFile(
          `./fixtures/${testCategory}/positive/${fixtureName}`,
          testUnitContent,
        );
        debugLog("✨", testUnitName);
      } else {
        await fs.writeFile(
          `./fixtures/${testCategory}/negative/${fixtureName}`,
          testUnitContent,
        );
        debugErr("💥", testUnitName);

        for (const [code, message] of errorDiagnosticsToBeSupported)
          supportedErrorDiagnostics.set(code, message);
      }
    }
    debugLog();
  }
}

// TODO: Save supportted codes and log it for future update
console.log("🍀", "Writing supported error diagnostics");
console.log("```js");
for (const [code, message] of Array.from(supportedErrorDiagnostics).sort(
  ([a], [b]) => a - b,
))
  console.log(`${code}, // ${message}`);
console.log("```");

// ---

async function parseTypeScriptLikeOxc(filename: string, code: string) {
  const project = await createProject({
    useInMemoryFileSystem: true,
    // TODO: Consider other options later for faster parsing
    compilerOptions: {
      // OXC has no option equivalent, always parses the latest syntax
      target: ts.ScriptTarget.ESNext,
      jsx: filename.endsWith(".tsx") ? ts.JsxEmit.Preserve : ts.JsxEmit.None,
      // TODO: Add more options...?
    },
  });

  project.createSourceFile(filename, code);
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
function debugAssert(cond: boolean, message: string) {
  if (!ENABLE_DEBUG || cond) return;
  console.error("[Assertion failed]", message);
  process.exit(1);
}
