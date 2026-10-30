import { createRequire, builtinModules } from "node:module";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { CandidateManifest } from "../types.ts";
import {
	PREFLIGHT_MANIFEST_ENV,
	PREFLIGHT_RESULT_ENV,
	writeWorkerResult,
	type StaticCheckWorkerResult,
} from "./child-protocol.ts";

const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const MAX_GRAPH_FILES = 2_000;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const BUILTINS = new Set(builtinModules);

function contains(parent: string, candidate: string): boolean {
	const rel = relative(resolve(parent), resolve(candidate));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function scriptKind(path: string): ts.ScriptKind {
	switch (extname(path).toLowerCase()) {
		case ".ts":
		case ".mts":
		case ".cts":
			return ts.ScriptKind.TS;
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.ScriptKind.JS;
		default:
			return ts.ScriptKind.TS;
	}
}

function isTypeOnlyImport(declaration: ts.ImportDeclaration): boolean {
	if (declaration.importClause === undefined) return true;
	if (declaration.importClause.isTypeOnly) return true;
	const clause = declaration.importClause;
	if (clause.name !== undefined) return false;
	if (clause.namedBindings === undefined) return true;
	if (ts.isNamespaceImport(clause.namedBindings)) return false;
	return clause.namedBindings.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyExport(declaration: ts.ExportDeclaration): boolean {
	if (declaration.isTypeOnly) return true;
	if (declaration.exportClause !== undefined && ts.isNamedExports(declaration.exportClause)) {
		return declaration.exportClause.elements.every((element) => element.isTypeOnly);
	}
	return false;
}

interface ModuleReference {
	readonly specifier: string;
	readonly runtime: boolean;
	readonly position: number;
}

function moduleReferences(sourceFile: ts.SourceFile): ModuleReference[] {
	const references: ModuleReference[] = [];
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
			references.push({
				specifier: statement.moduleSpecifier.text,
				runtime: !isTypeOnlyImport(statement),
				position: statement.getStart(sourceFile),
			});
		} else if (
			ts.isExportDeclaration(statement) &&
			statement.moduleSpecifier !== undefined &&
			ts.isStringLiteral(statement.moduleSpecifier)
		) {
			references.push({
				specifier: statement.moduleSpecifier.text,
				runtime: !isTypeOnlyExport(statement),
				position: statement.getStart(sourceFile),
			});
		} else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
			const expression = statement.moduleReference.expression;
			if (expression !== undefined && ts.isStringLiteral(expression)) {
				references.push({
					specifier: expression.text,
					runtime: !statement.isTypeOnly,
					position: statement.getStart(sourceFile),
				});
			}
		}
	}
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const firstArgument = node.arguments[0];
			if (
				firstArgument !== undefined &&
				ts.isStringLiteralLike(firstArgument) &&
				((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
					node.expression.kind === ts.SyntaxKind.ImportKeyword)
			) {
				references.push({
					specifier: firstArgument.text,
					runtime: true,
					position: node.getStart(sourceFile),
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(sourceFile, visit);
	return references;
}

async function statFile(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
	try {
		const info = await lstat(path);
		return info.isFile() ? info : null;
	} catch {
		return null;
	}
}

async function resolveFileCandidate(candidate: string): Promise<string | null> {
	const direct = await statFile(candidate);
	if (direct !== null) return candidate;
	for (const extension of SUPPORTED_EXTENSIONS) {
		const path = `${candidate}${extension}`;
		if ((await statFile(path)) !== null) return path;
	}
	if (candidate.endsWith(".js")) {
		const stem = candidate.slice(0, -3);
		for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
			const path = `${stem}${extension}`;
			if ((await statFile(path)) !== null) return path;
		}
	}
	const directory = await lstat(candidate).catch(() => null);
	if (directory?.isDirectory()) {
		try {
			const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8")) as Record<string, unknown>;
			for (const field of ["types", "module", "main"]) {
				const value = manifest[field];
				if (typeof value !== "string") continue;
				const resolved = await resolveFileCandidate(resolve(candidate, value));
				if (resolved !== null) return resolved;
			}
		} catch {
			// No package manifest.
		}
		for (const extension of SUPPORTED_EXTENSIONS) {
			const path = join(candidate, `index${extension}`);
			if ((await statFile(path)) !== null) return path;
		}
	}
	return null;
}

function packageSpecifierParts(specifier: string): { readonly name: string; readonly subpath: string } | null {
	const parts = specifier.split("/");
	if (specifier.startsWith("@")) {
		if (parts.length < 2 || parts[0]!.length === 0 || parts[1]!.length === 0) return null;
		const name = `${parts[0]}/${parts[1]}`;
		const rest = parts.slice(2).join("/");
		return { name, subpath: rest.length === 0 ? "." : `./${rest}` };
	}
	if (parts[0] === undefined || parts[0].length === 0) return null;
	const rest = parts.slice(1).join("/");
	return { name: parts[0], subpath: rest.length === 0 ? "." : `./${rest}` };
}

function pickConditions(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const picked = pickConditions(item);
			if (picked !== null) return picked;
		}
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	for (const condition of ["node", "import", "default", "require"]) {
		if (condition in record) {
			const picked = pickConditions(record[condition]);
			if (picked !== null) return picked;
		}
	}
	return null;
}

function pickExportTarget(exportsField: unknown, subpath: string): string | null {
	if (typeof exportsField === "string") return subpath === "." ? exportsField : null;
	if (exportsField === null || typeof exportsField !== "object" || Array.isArray(exportsField)) return null;
	const record = exportsField as Record<string, unknown>;
	const keys = Object.keys(record);
	if (!keys.some((key) => key.startsWith("."))) {
		return subpath === "." ? pickConditions(exportsField) : null;
	}
	if (subpath in record) {
		const picked = pickConditions(record[subpath]);
		if (picked !== null) return picked;
	}
	for (const key of keys) {
		const star = key.indexOf("*");
		if (star === -1) continue;
		const prefix = key.slice(0, star);
		const suffix = key.slice(star + 1);
		if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
		const wildcard = subpath.slice(prefix.length, subpath.length - suffix.length);
		const target = pickConditions(record[key]);
		if (target !== null) return target.replaceAll("*", wildcard);
	}
	return null;
}

async function readPackageManifest(packageRoot: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as unknown;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

async function resolvePackageTarget(packageRoot: string, subpath: string): Promise<string | null> {
	const manifest = await readPackageManifest(packageRoot);
	if (manifest === null) return null;
	if (manifest.exports !== undefined) {
		const target = pickExportTarget(manifest.exports, subpath);
		if (target === null) return null;
		return resolveFileCandidate(resolve(packageRoot, target));
	}
	if (subpath !== ".") return resolveFileCandidate(join(packageRoot, subpath.slice(2)));
	for (const field of ["module", "main"]) {
		const value = manifest[field];
		if (typeof value !== "string") continue;
		const resolved = await resolveFileCandidate(resolve(packageRoot, value));
		if (resolved !== null) return resolved;
	}
	return resolveFileCandidate(join(packageRoot, "index"));
}

async function findPackageRoot(fromFile: string, packageName: string): Promise<string | null> {
	let directory = dirname(fromFile);
	for (;;) {
		const candidate = join(directory, "node_modules", packageName);
		const info = await lstat(candidate).catch(() => null);
		if (info?.isDirectory() === true) return candidate;
		const parent = dirname(directory);
		if (parent === directory) return null;
		directory = parent;
	}
}

async function resolveBareSpecifier(
	specifier: string,
	fromFile: string,
	manifest: CandidateManifest,
	candidateRoot: string,
): Promise<{ readonly status: "external" | "local"; readonly path: string } | null> {
	const parts = packageSpecifierParts(specifier);
	if (parts === null) return null;
	const requireFromFile = createRequire(fromFile);
	let resolved: string | null = null;
	try {
		resolved = requireFromFile.resolve(specifier);
	} catch {
		resolved = null;
	}
	if (resolved === null) {
		const candidatePackage = await findPackageRoot(fromFile, parts.name);
		if (candidatePackage !== null) resolved = await resolvePackageTarget(candidatePackage, parts.subpath);
	}
	if (resolved === null) {
		for (const root of manifest.trustedDependencyRoots) {
			const packageRoot = join(root, parts.name);
			const info = await lstat(packageRoot).catch(() => null);
			if (info?.isDirectory() !== true) continue;
			resolved = await resolvePackageTarget(packageRoot, parts.subpath);
			if (resolved !== null) break;
		}
	}
	if (resolved === null) return null;
	const real = await realpath(resolved).catch(() => resolve(resolved));
	if (contains(candidateRoot, real)) return { status: "local", path: real };
	if (manifest.trustedDependencyRoots.some((root) => contains(root, real))) return { status: "external", path: real };
	// A writable ancestor node_modules is not a reload input.
	return null;
}

async function checkModuleGraph(
	manifest: CandidateManifest,
	candidateRoot: string,
): Promise<{ readonly errors: string[]; readonly checked: number; readonly external: number }> {
	const errors: string[] = [];
	const queue: string[] = [];
	for (const entry of manifest.entries) {
		const absolute = resolve(candidateRoot, entry);
		if (!contains(candidateRoot, absolute)) {
			errors.push(`Entry escapes candidate: ${entry}`);
			continue;
		}
		queue.push(absolute);
	}
	const seen = new Set<string>();
	let externalModules = 0;
	while (queue.length > 0) {
		if (seen.size >= MAX_GRAPH_FILES) {
			errors.push(`Static module graph exceeds ${MAX_GRAPH_FILES} files.`);
			break;
		}
		const file = queue.shift() as string;
		const real = await realpath(file).catch(() => file);
		if (seen.has(real)) continue;
		seen.add(real);
		if (!contains(candidateRoot, real)) {
			errors.push(`Local module resolves outside candidate: ${file}`);
			continue;
		}
		const extension = extname(real).toLowerCase();
		if (!SUPPORTED_EXTENSIONS.includes(extension as (typeof SUPPORTED_EXTENSIONS)[number])) {
			if (extension === ".json" || extension === ".node") continue;
			errors.push(`Unsupported local module type: ${real}`);
			continue;
		}
		let text: string;
		try {
			const info = await lstat(real);
			if (!info.isFile() || info.size > MAX_SOURCE_BYTES) {
				errors.push(`Local module is not a bounded regular file: ${real}`);
				continue;
			}
			text = await readFile(real, "utf8");
		} catch (error) {
			errors.push(`Could not read local module ${real}: ${String(error)}`);
			continue;
		}
		const sourceFile = ts.createSourceFile(real, text, ts.ScriptTarget.Latest, true, scriptKind(real));
		const transpiled = ts.transpileModule(text, {
			fileName: real,
			reportDiagnostics: true,
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				jsx: ts.JsxEmit.Preserve,
				allowJs: true,
				checkJs: false,
				isolatedModules: true,
				noEmit: true,
				skipLibCheck: true,
			},
		});
		for (const diagnostic of transpiled.diagnostics ?? []) {
			const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
			let location = real;
			if (diagnostic.start !== undefined) {
				const position = ts.getLineAndCharacterOfPosition(sourceFile, diagnostic.start);
				location = `${real}:${position.line + 1}:${position.character + 1}`;
			}
			errors.push(`${location} TS${diagnostic.code}: ${message}`);
		}
		for (const reference of moduleReferences(sourceFile)) {
			const specifier = reference.specifier;
			if (specifier.startsWith("node:") || BUILTINS.has(specifier)) continue;
			if (specifier.startsWith("data:") || specifier.startsWith("http:") || specifier.startsWith("https:")) {
				if (reference.runtime) {
					errors.push(`${real}: unsupported runtime module URL ${specifier}`);
				}
				continue;
			}
			if (specifier.startsWith("file:")) {
				const path = fileURLToPath(specifier);
				if (!contains(candidateRoot, path)) {
					errors.push(`${real}: file URL escapes candidate ${specifier}`);
				} else {
					const resolved = await resolveFileCandidate(path);
					if (resolved === null) {
						errors.push(`${real}: missing file URL import ${specifier}`);
					} else {
						queue.push(resolved);
					}
				}
				continue;
			}
			if (specifier.startsWith(".") || isAbsolute(specifier)) {
				const base = isAbsolute(specifier) ? specifier : resolve(dirname(real), specifier);
				const resolved = await resolveFileCandidate(base);
				if (resolved === null) {
					if (reference.runtime) errors.push(`${real}: missing local import ${specifier}`);
					continue;
				}
				if (!contains(candidateRoot, resolved)) {
					errors.push(`${real}: local import escapes candidate ${specifier}`);
					continue;
				}
				queue.push(resolved);
				continue;
			}
			const resolved = await resolveBareSpecifier(specifier, real, manifest, candidateRoot);
			if (resolved === null) {
				if (reference.runtime) {
					errors.push(`${real}: missing package import ${specifier} (not in candidate or trusted dependencies)`);
				}
				continue;
			}
			if (resolved.status === "local") queue.push(resolved.path);
			else externalModules++;
		}
	}
	return { errors, checked: seen.size, external: externalModules };
}

async function main(): Promise<StaticCheckWorkerResult> {
	const manifestPath = process.env[PREFLIGHT_MANIFEST_ENV];
	const resultPath = process.env[PREFLIGHT_RESULT_ENV];
	const errors: string[] = [];
	if (!manifestPath) {
		return { kind: "static", ok: false, errors: ["Missing preflight manifest path."], filesChecked: 0, externalModules: 0 };
	}
	const candidateRoot = dirname(resolve(manifestPath));
	let manifest: CandidateManifest;
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CandidateManifest;
	} catch (error) {
		return {
			kind: "static",
			ok: false,
			errors: [`Could not read preflight manifest: ${String(error)}`],
			filesChecked: 0,
			externalModules: 0,
			stack: error instanceof Error ? error.stack ?? error.message : undefined,
		};
	}
	try {
		const graph = await checkModuleGraph(manifest, candidateRoot);
		errors.push(...graph.errors);
		const result: StaticCheckWorkerResult = {
			kind: "static",
			ok: errors.length === 0,
			errors,
			filesChecked: graph.checked,
			externalModules: graph.external,
		};
		writeWorkerResult(resultPath, result);
		return result;
	} catch (error) {
		const result: StaticCheckWorkerResult = {
			kind: "static",
			ok: false,
			errors: [`Static checker crashed: ${error instanceof Error ? error.message : String(error)}`],
			filesChecked: 0,
			externalModules: 0,
			stack: error instanceof Error ? error.stack ?? error.message : undefined,
		};
		writeWorkerResult(resultPath, result);
		return result;
	}
}

const result = await main();
if (!result.ok) process.exitCode = 1;
