# oxc-tsc-fixtures

Generate TypeScriptCompiler test fixtures for OXC.

## Motivation

- Want to measure the coverage when implementing a TypeScript-compatible parser like OXC
- As a rich catalog of TS(X) files, we would like to refer the tests in `compiler` and `conformance` from the TSC
- However, these are only the results of TSC's snapshot tests and do not specifically verify just the parsing process
  - In the first place, they probably weren't intended for external use 😅
  - Test cases consist of multiple `@filename` units, some of which may be files like `.d.ts`, `.md`, `.json`, etc!
- For a general parser implementation, the following perspectives are unnecessary:
  - Pure type error tests
  - Type definition file tests
  - Module resolution tests
  - Tests composed of multiple files
  - Tests related to TSC configuration
  - etc...
  - For OXC, tests specifying old versions like `target: es5` are also unnecessary
- To purely verify syntax and its errors, we want to exclude such unnecessary test cases

## How it works

- Parse all test fixtures again using `@ts-morph` with OXC-like settings
- Skip test units that are not of interest for OXC
  - With non-TS(X) like extension
  - Which returns unsupported `Diagnostic.code`
- Based on whether parsing succeeds without errors, classify as positive or negative cases and save the file

## Usage

```sh
# or bun
npx tsx src/main.ts

# With options
DEBUG=1 NO_SAVE=1 TS_REPO_DIR=../TypeScript npx tsx src/main.ts
```

Outputs are placed in `./fixtures/(compiler|conformance)/(positive|negative)`.

## TODOs

- Perf...
- Use `oxc-parser` w/ `checkSemantic: true` and precheck before integrating `oxc` repo
  - Parsed: passed + failed_not_panic / all_passed
  - Positive: passed / all_passed
  - Negative: failed / all_failed
- List more unspported error codes
