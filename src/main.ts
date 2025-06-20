import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { glob } from "tinyglobby";

const ENABLE_DEBUG = process.env.DEBUG;

const TYPESCRIPT_REPO_DIR = resolve("../TypeScript");

// TODO: List all codes that OXC does not support, e.g. type-only diagnostics!
const DIAGNOSTIC_CODES_OXC_DOES_NOT_SUPPORT = new Set([
  // 2304, // Cannot find name 'React'.
  2315, // Type 'U' is not generic.
  2322, // Type 'interfaceWithPublicAndOptional<number, string>' is not assignable to type '{ one: string; }'.
  2403, // Subsequent variable declarations must have the same type.
  2416, // Property 'every' in type 'MyArray<T>' is not assignable to the same property in base type 'T[]'.
  2580, // Cannot find name 'module'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
  2589, // Type instantiation is excessively deep and possibly infinite.
  2792, // Cannot find module './file1'. Did you mean to set the 'moduleResolution' option to 'nodenext', or to add aliases to the 'paths' option?
]);

// TODO: Make it parallel!

// TODO: Correct support codes and log it for future update

const {
  TestCaseParser: { makeUnitsFromTest },
} = await import(`${TYPESCRIPT_REPO_DIR}/src/harness/harnessIO.ts`);

console.time("Total");
for (const testCategory of ["compiler"]) {
  const cwd = `${TYPESCRIPT_REPO_DIR}/tests/cases/${testCategory}`;

  const testFilePaths = await glob(`**/*`, { cwd });
  for (const testFilePath of testFilePaths) {
    const testText = await readFile(`${cwd}/${testFilePath}`, "utf8");
    // TODO: This should be rewritten by ourselves?
    const testUnits = makeUnitsFromTest(testText, testFilePath);

    debugLog(`${testFilePath} - ${testUnits.testUnitData.length} unit(s)`);
    for (const testUnit of testUnits.testUnitData) {
      if (testUnit.name.endsWith(".d.ts") || testUnit.name.endsWith(".json")) {
        debugLog("🍃", testUnit.name);
        continue;
      }

      try {
        const errorDiagnostics = await parseTypeScriptLikeOxc(
          testUnit.name,
          testUnit.content,
        );

        if (errorDiagnostics.size === 0) {
          // TODO: This is "Expect to parse" case, save path+idx, or write content to the disk?
          debugLog("✨", testUnit.name);
        } else {
          debugErr("💥", testUnit.name);
          // TODO: This is "Expect Syntax Error" case, save path+idx, or write content to the disk?
          for (const [code, message] of errorDiagnostics)
            debugErr("  ", `${code}, // ${message}`);
        }
      } catch (err) {
        // NOTE: If `@types` options is used, TSC try to load it's type definitions.
        // if (err.message.startsWith("Directory not found:")) continue;
        console.error("Unexpected error on parse()", err.message);
        process.exit(1);
      }
    }
    debugLog();
  }
}
console.timeEnd("Total");

// ---

function debugLog(...args: any[]) {
  if (ENABLE_DEBUG) console.log(...args);
}
function debugErr(...args: any[]) {
  if (ENABLE_DEBUG) console.error(...args);
}

// NOTE: `@ts-morph/bootstrap` is the most handy, but we should consider using `typescript` or `typescript-go`?
// `typescript` is not a peer dependency of `@ts-morph/bootstrap`, so its version is uncontrollable for us.
import { createProject, ts } from "@ts-morph/bootstrap";
// TODO: Print it
ts.version;

// `filename` may be
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
  const errorDiagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];

  const errorDiagnosticsToBeVerified = new Map<number, string>();
  for (const diagnostic of errorDiagnostics) {
    // We only need critical errors
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;

    if (DIAGNOSTIC_CODES_OXC_DOES_NOT_SUPPORT.has(diagnostic.code)) continue;

    errorDiagnosticsToBeVerified.set(
      diagnostic.code,
      typeof diagnostic.messageText === "string"
        ? diagnostic.messageText
        : diagnostic.messageText.messageText,
    );
  }

  return errorDiagnosticsToBeVerified;
}
