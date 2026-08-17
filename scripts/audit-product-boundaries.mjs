import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const PRODUCTS = Object.freeze([
  {
    name: "npc-moneyhand",
    root: resolve(ROOT, "skills/npc-moneyhand"),
    packageJson: true,
  },
  {
    name: "npc-moneyhand-extension",
    root: resolve(ROOT, "extension"),
    packageJson: false,
  },
]);

function filesUnder(root) {
  const output = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  visit(root);
  return output;
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === ""
    || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function importSpecifiers(source) {
  const values = [];
  const staticPattern = /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s*)?["']([^"']+)["']/gu;
  const dynamicPattern = /\bimport\s*\(\s*["']([^"']+)["']/gu;
  for (const pattern of [staticPattern, dynamicPattern]) {
    for (const match of source.matchAll(pattern)) values.push(match[1]);
  }
  return [...new Set(values)];
}

function dependencyNames(packageJson) {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
  ];
}

function auditProduct(product) {
  const files = filesUnder(product.root);
  const sourceFiles = files.filter((path) => SOURCE_EXTENSIONS.has(extname(path)));
  const violations = [];
  let externalPackages = [];
  if (product.packageJson) {
    const packageJson = JSON.parse(readFileSync(resolve(product.root, "package.json"), "utf8"));
    externalPackages = dependencyNames(packageJson);
    for (const dependency of externalPackages) {
      violations.push(`package.json declares runtime dependency '${dependency}'`);
    }
  }
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        violations.push(`${relative(product.root, file)} imports external '${specifier}'`);
        continue;
      }
      const target = resolve(dirname(file), specifier);
      if (!isInside(product.root, target)) {
        violations.push(`${relative(product.root, file)} crosses product boundary via '${specifier}'`);
      }
    }
  }
  return {
    name: product.name,
    files: files.length,
    bytes: files.reduce((total, path) => total + statSync(path).size, 0),
    sourceFiles: sourceFiles.length,
    externalPackages,
    boundaryViolations: violations,
  };
}

const products = PRODUCTS.map(auditProduct);

const report = {
  schema: "npc-product-boundary-audit/1",
  products,
  passed: products.every((product) => product.boundaryViolations.length === 0),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
