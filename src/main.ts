import path from "node:path";
import fs from "node:fs/promises";
import { glob } from "tinyglobby";
// NOTE: `@ts-morph/bootstrap` is the most handy, but we should consider using `typescript` or `typescript-go`?
// `typescript` is not a peer dependency of `@ts-morph/bootstrap`, so its version is uncontrollable for us.
import { createProject, ts } from "@ts-morph/bootstrap";

// List all codes that OXC does not support!
// e.g. Type-only, module resolution, etc...
const DIAGNOSTIC_CODES_OXC_DOES_NOT_SUPPORT = new Set([
  2315, // Type 'U' is not generic.
  2322, // Type 'interfaceWithPublicAndOptional<number, string>' is not assignable to type '{ one: string; }'.
  2339, // Property 'protectedMethod' does not exist on type 'never'.
  2349, // This expression is not callable.
  2355, // A function whose declared type is neither 'undefined', 'void', nor 'any' must return a value.
  2365, // Operator '+' cannot be applied to types 'number' and '{}'.
  2367, // This comparison appears to be unintentional because the types 'T' and '"x"' have no overlap.
  2403, // Subsequent variable declarations must have the same type.
  2416, // Property 'every' in type 'MyArray<T>' is not assignable to the same property in base type 'T[]'.
  2430, // Interface 'Set<T>' incorrectly extends interface 'Collection<never, T>'.
  2449, // Class 'Base' used before its declaration.
  2506, // 'S18' is referenced directly or indirectly in its own base expression.
  2540, // Cannot assign to 'B' because it is a read-only property.
  2552, // Cannot find name 'myConst2'. Did you mean 'myConst1'?
  2554, // Expected 2 arguments, but got 1.
  2559, // Type 'bigint' has no properties in common with type '{ t?: string; }'.
  2578, // Unused '@ts-expect-error' directive.
  2580, // Cannot find name 'module'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
  2589, // Type instantiation is excessively deep and possibly infinite.
  2661, // Cannot export 'globalThis'. Only local declarations can be exported from a module.
  2664, // Invalid module name in augmentation, module 'ext' cannot be found.
  2669, // Augmentations for the global scope can only be directly nested in external modules or ambient module declarations.
  2688, // Cannot find type definition file for 'node'.
  2693, // 'number' only refers to a type, but is being used as a value here.
  2694, // Namespace 'mglo5' has no exported member 'i6'.
  2739, // Type 'SharedArrayBuffer' is missing the following properties from type 'ArrayBuffer': resizable, resize, detached, transfer, transferToFixedLength
  2741, // Property 'key' is missing in type '{ x: number; }' but required in type 'IntrinsicAttributes'.
  2792, // Cannot find module './file1'. Did you mean to set the 'moduleResolution' option to 'nodenext', or to add aliases to the 'paths' option?
  2872, // This kind of expression is always truthy.
  6053, // File '/declarations.d.ts' not found.
  2551, // Property 'methodA' does not exist on type 'B'. Did you mean 'methodB'?
  8020, // JSDoc types can only be used inside documentation comments.
  18033, // Type '{}' is not assignable to type 'number' as required for computed enum member values.
  // TODO: Add more and more!
]);

// ---

console.log("🍀", "Reesolving environment variables and dependencies");
const IS_DEBUG = process.env.DEBUG ? true : false;
const IS_UPDATE = process.env.NO_SAVE ? false : true;
const TS_REPO_DIR = process.env.TS_REPO_DIR ?? "./typescript";
console.log({ IS_DEBUG, IS_UPDATE, TS_REPO_DIR });

const TEST_CATEGORIES = ["compiler", "conformance"];
const TYPESCRIPT_REPO_ROOT = path.resolve(TS_REPO_DIR);

console.log("🍀", "Using TS version:", ts.version);
// NOTE: Should be rewritten by ourselves?
const {
  TestCaseParser: { makeUnitsFromTest },
} = await import(`${TYPESCRIPT_REPO_ROOT}/src/harness/harnessIO`);

const debugLog = IS_DEBUG ? console.log.bind(console) : () => {};
const writeFile = IS_UPDATE ? fs.writeFile.bind(fs) : () => {};
const rm = IS_UPDATE ? fs.rm.bind(fs) : () => {};
const mkdir = IS_UPDATE ? fs.mkdir.bind(fs) : () => {};

// ---

console.log("🍀", "Cleaning up previous test results");
await rm("./fixtures", { recursive: true, force: true });
for (const testCategory of TEST_CATEGORIES) {
  await mkdir(`./fixtures/${testCategory}/positive`, { recursive: true });
  await mkdir(`./fixtures/${testCategory}/negative`, { recursive: true });
}

// TODO: Make it parallel!

const reports: Record<string, any> = {};
const allErrorDiagnosticsToBeSupported = new Map<number, string>();
for (const testCategory of TEST_CATEGORIES) {
  const cwd = `${TYPESCRIPT_REPO_ROOT}/tests/cases/${testCategory}`;
  const testFileNames = await glob(`**/*`, { cwd });
  console.log(
    "🍀",
    `[${testCategory}] Processing ${testFileNames.length} test cases...`,
  );

  const stats = {
    positive: 0,
    negative: 0,
  };
  for (const testFileName of testFileNames) {
    const testText = await fs.readFile(path.resolve(cwd, testFileName), "utf8");
    const testUnits = makeUnitsFromTest(testText, testFileName);

    debugLog(
      `[${testCategory}] ${testFileName} - ${testUnits.testUnitData.length} unit(s)`,
    );
    for (const {
      name: testUnitName,
      content: testUnitContent,
    } of testUnits.testUnitData) {
      if (!isSupportedTestUnit(testUnitName, testUnitContent)) {
        debugLog("💤", testUnitName);
        continue;
      }

      debugLog("👀", testUnitName);
      const diagnostics = await parseTypeScriptLikeOxc(
        testUnitName,
        testUnitContent,
        // TODO: Pass @xxx settings?
      );

      const errorDiagnosticsToBeSupported =
        extractErrorDiagnosticsToBeSupported(diagnostics);

      // Both `testFileName` and `testUnitName` may contain `/`, but we don't care, just flatten them
      const fixtureName = `${testFileName}/${testUnitName}`.replaceAll(
        "/",
        "+",
      );
      if (errorDiagnosticsToBeSupported.size === 0) {
        const fixturePath = `./fixtures/${testCategory}/positive/${fixtureName}`;
        await writeFile(fixturePath, testUnitContent);
        debugLog(" └─", "✨", fixturePath);
        stats.positive++;
      } else {
        const fixturePath = `./fixtures/${testCategory}/negative/${fixtureName}`;
        await writeFile(fixturePath, testUnitContent);
        debugLog(" └─", "💥", fixturePath);
        stats.negative++;

        for (const [code, message] of errorDiagnosticsToBeSupported)
          allErrorDiagnosticsToBeSupported.set(code, message);
      }
    }
    debugLog();
  }

  reports[testCategory] = stats;
}
console.log("🍀", "Fixtures are written to `./fixtures`");
console.log(reports);

const sortedAllErrorDiagnosticsToBeSupported = new Map(
  Array.from(allErrorDiagnosticsToBeSupported).sort(([a], [b]) => a - b),
);
console.log(
  "🍀",
  `Writing ${sortedAllErrorDiagnosticsToBeSupported.size} error diagnostics to be supported`,
);
writeFile(
  `./fixtures/error-codes-to-be-supported.txt`,
  Array.from(sortedAllErrorDiagnosticsToBeSupported.keys()).join("\n"),
);
for (const [code, message] of sortedAllErrorDiagnosticsToBeSupported)
  console.log(`${code}, // ${message}`);

// ---

function isSupportedTestUnit(fileName: string, fileContent: string) {
  // This is `undefined` if multiple `@filename` are used...
  if (typeof fileContent !== "string") return false;
  if (fileContent.trim() === "") return false;

  // Skip if the test unit is not a TypeScript-like file
  // e.g. `.json`, `.md`, `.css`, `.js.map`, etc...
  if ([".d.ts", ".d.mts", ".d.cts"].some((ext) => fileName.endsWith(ext)))
    return false;
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

  // PERF: Use flat file name
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
