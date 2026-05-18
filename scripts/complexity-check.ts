type FunctionComplexity = {
  file: string;
  name: string;
  line: number;
  complexity: number;
};

const DEFAULT_MAX_COMPLEXITY = 22;
const DEFAULT_PATHS = ["main.ts", "src"];
const CONTROL_KEYWORDS = new Set([
  "catch",
  "else",
  "for",
  "if",
  "switch",
  "while",
]);

function parseArgs(args: string[]): { max: number; paths: string[] } {
  let max = DEFAULT_MAX_COMPLEXITY;
  const paths: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--max") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--max must be a positive integer");
      }
      max = value;
      index += 1;
      continue;
    }
    paths.push(arg);
  }

  return { max, paths: paths.length > 0 ? paths : DEFAULT_PATHS };
}

async function collectTsFiles(path: string): Promise<string[]> {
  if (path.split("/").includes("__tests__")) return [];

  const stat = await Deno.stat(path);
  if (stat.isFile) return path.endsWith(".ts") ? [path] : [];
  if (!stat.isDirectory) return [];

  const files: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    if (entry.name === "__tests__") continue;
    files.push(...await collectTsFiles(`${path}/${entry.name}`));
  }
  return files;
}

function stripCommentsAndStrings(source: string): string {
  let output = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < source.length) {
        const current = source[index];
        output += current === "\n" ? "\n" : " ";
        if (current === "*" && source[index + 1] === "/") {
          output += " ";
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      output += " ";
      index += 1;
      while (index < source.length) {
        const current = source[index];
        output += current === "\n" ? "\n" : " ";
        index += current === "\\" ? 2 : 1;
        if (current === quote) break;
      }
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findMatchingParen(source: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findNextBrace(source: string, startIndex: number): number {
  for (let index = startIndex; index < source.length; index += 1) {
    if (source[index] === "{") return index;
    if (source[index] === ";") return -1;
  }
  return -1;
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function countTernaries(source: string): number {
  let count = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "?") continue;
    const previous = source[index - 1];
    const next = source[index + 1];
    if (previous === "?" || previous === "." || next === "?" || next === ".") {
      continue;
    }

    let nextNonSpace = "";
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      if (!/\s/.test(source[cursor])) {
        nextNonSpace = source[cursor];
        break;
      }
    }
    if (nextNonSpace === ":") continue;
    count += 1;
  }
  return count;
}

function calculateComplexity(body: string): number {
  const keywordMatches = body.match(/\b(if|for|while|case|catch)\b/g) ?? [];
  const logicalMatches = body.match(/&&|\|\|/g) ?? [];
  return 1 + keywordMatches.length + logicalMatches.length +
    countTernaries(body);
}

function analyzeFile(file: string, source: string): FunctionComplexity[] {
  const stripped = stripCommentsAndStrings(source);
  const functions: FunctionComplexity[] = [];
  const seenRanges = new Set<string>();

  function addFunction(
    name: string,
    nameIndex: number,
    openBrace: number,
  ): void {
    const closeBrace = findMatchingBrace(stripped, openBrace);
    if (closeBrace === -1) return;

    const range = `${openBrace}:${closeBrace}`;
    if (seenRanges.has(range)) return;
    seenRanges.add(range);

    functions.push({
      file,
      name,
      line: lineNumber(source, nameIndex),
      complexity: calculateComplexity(
        stripped.slice(openBrace + 1, closeBrace),
      ),
    });
  }

  const functionPattern =
    /\b(?:export\s+)?(?:async\s+)?function(?:\s*\*)?\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of stripped.matchAll(functionPattern)) {
    const openParen = stripped.indexOf("(", match.index);
    const closeParen = findMatchingParen(stripped, openParen);
    const openBrace = findNextBrace(stripped, closeParen + 1);
    if (openBrace !== -1) addFunction(match[1], match.index, openBrace);
  }

  const arrowPattern =
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=>\s*\{/g;
  for (const match of stripped.matchAll(arrowPattern)) {
    const openBrace = match.index + match[0].lastIndexOf("{");
    addFunction(match[1], match.index, openBrace);
  }

  const methodPattern =
    /(?:^|[\n;{}])\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=>]+)?\{/g;
  for (const match of stripped.matchAll(methodPattern)) {
    const name = match[1];
    if (CONTROL_KEYWORDS.has(name)) continue;
    const openBrace = match.index + match[0].lastIndexOf("{");
    addFunction(name, match.index + match[0].indexOf(name), openBrace);
  }

  return functions;
}

const { max, paths } = parseArgs(Deno.args);
const files = [
  ...new Set((await Promise.all(paths.map(collectTsFiles))).flat()),
].sort();
const functions = (
  await Promise.all(
    files.map(async (file) => analyzeFile(file, await Deno.readTextFile(file))),
  )
).flat();
const violations = functions
  .filter((item) => item.complexity > max)
  .sort((a, b) => b.complexity - a.complexity);

if (violations.length > 0) {
  console.error(
    `Complexity check failed. Maximum allowed complexity is ${max}.`,
  );
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.line} ${violation.name} complexity=${violation.complexity}`,
    );
  }
  Deno.exit(1);
}

const highest = functions.reduce(
  (maxItem, item) => item.complexity > maxItem.complexity ? item : maxItem,
  { file: "", name: "none", line: 0, complexity: 0 },
);
console.log(
  `Complexity check passed: ${functions.length} functions, max ${highest.complexity} (${highest.file}:${highest.line} ${highest.name}), threshold ${max}.`,
);
