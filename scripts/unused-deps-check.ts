const DEFAULT_PATHS = ["main.ts", "src", "scripts"];
const IGNORED_DIRS = new Set([
  ".git",
  "coverage",
  "node_modules",
  ".deno",
  "deno_dir",
  "deno_cache",
]);
const CHECKED_EXTENSIONS = new Set([".ts", ".js", ".mjs"]);

async function collectFiles(path: string): Promise<string[]> {
  const stat = await Deno.stat(path);
  if (stat.isFile) return shouldCheck(path) ? [path] : [];
  if (!stat.isDirectory) return [];

  const files: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    if (entry.isDirectory && shouldIgnoreDirectory(entry.name)) continue;
    files.push(...await collectFiles(`${path}/${entry.name}`));
  }
  return files;
}

function shouldIgnoreDirectory(name: string): boolean {
  return IGNORED_DIRS.has(name) || name.startsWith(".deno-kv-local");
}

function shouldCheck(path: string): boolean {
  return CHECKED_EXTENSIONS.has(extensionOf(path));
}

function extensionOf(path: string): string {
  const fileName = path.split("/").at(-1) ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "" : fileName.slice(dotIndex);
}

function isImportMapDependencyUsed(source: string, specifier: string): boolean {
  if (specifier.endsWith("/")) {
    return source.includes(`"${specifier}`) ||
      source.includes(`'${specifier}`);
  }
  return source.includes(`"${specifier}"`) ||
    source.includes(`'${specifier}'`);
}

type DenoConfig = {
  imports?: Record<string, string>;
};

const config = JSON.parse(await Deno.readTextFile("deno.json")) as DenoConfig;
const imports = Object.keys(config.imports ?? {}).sort();

if (imports.length === 0) {
  console.log("Unused dependency check passed: no import map entries.");
  Deno.exit(0);
}

const paths = Deno.args.length > 0 ? Deno.args : DEFAULT_PATHS;
const files = [
  ...new Set((await Promise.all(paths.map(collectFiles))).flat()),
].sort();
const sources = await Promise.all(files.map((file) => Deno.readTextFile(file)));
const source = sources.join("\n");
const unused = imports.filter((specifier) =>
  !isImportMapDependencyUsed(source, specifier)
);

if (unused.length > 0) {
  console.error("Unused dependency check failed. Unused deno.json imports:");
  for (const specifier of unused) {
    console.error(`- ${specifier}`);
  }
  Deno.exit(1);
}

console.log(
  `Unused dependency check passed: ${imports.length} imports checked across ${files.length} files.`,
);
