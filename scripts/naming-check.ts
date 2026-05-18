const paths = Deno.args.length > 0 ? Deno.args : ["main.ts", "src"];
const kebabCasePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/;
const testFilePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*_test\.ts$/;
const allowedFiles = new Set(["main.ts"]);
const ignoredDirs = new Set([".git"]);

const failures: string[] = [];

async function checkPath(path: string): Promise<void> {
  const stat = await Deno.stat(path);
  if (stat.isFile) {
    checkFile(path);
    return;
  }
  if (!stat.isDirectory) return;

  for await (const entry of Deno.readDir(path)) {
    if (entry.isDirectory && ignoredDirs.has(entry.name)) continue;
    await checkPath(`${path}/${entry.name}`);
  }
}

function checkFile(path: string): void {
  if (!path.endsWith(".ts")) return;

  const fileName = path.split("/").at(-1);
  if (!fileName || allowedFiles.has(fileName)) return;

  const expectedPattern = path.includes("/__tests__/") &&
      fileName.endsWith("_test.ts")
    ? testFilePattern
    : kebabCasePattern;
  if (!expectedPattern.test(fileName)) {
    failures.push(path);
  }
}

for (const path of paths) {
  await checkPath(path);
}

if (failures.length > 0) {
  console.error(
    "Naming check failed. Use kebab-case file names; tests use kebab-case_test.ts.",
  );
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  Deno.exit(1);
}
