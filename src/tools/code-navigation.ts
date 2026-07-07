import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import ts from "typescript";
import { resolveInsideCwd } from "./file-ops.js";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	operation: Type.Union([
		Type.Literal("definition"),
		Type.Literal("references"),
		Type.Literal("hover"),
		Type.Literal("symbols"),
		Type.Literal("diagnostics"),
	]),
	path: Type.String({
		description: "TypeScript/JavaScript file path, absolute or relative to the project root.",
	}),
	line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line for definition/references/hover." })),
	column: Type.Optional(Type.Integer({ minimum: 1, description: "1-based column for definition/references/hover." })),
	query: Type.Optional(Type.String({ description: "Optional symbol-name filter for operation=symbols." })),
	include_external: Type.Optional(
		Type.Boolean({
			description:
				"Include locations outside the project root, such as node_modules declaration files. Default false.",
		}),
	),
	max_results: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 1000,
			description: "Maximum definitions/references/symbols/diagnostics to return. Default 200.",
		}),
	),
});

export type CodeNavigationParams = Static<typeof Params>;

type CodeNavigationOperation = CodeNavigationParams["operation"];

export interface CodeNavigationLocation {
	file: string;
	line: number;
	column: number;
	kind?: string;
	name?: string;
	isDefinition?: boolean;
	preview?: string;
}

export interface CodeNavigationDetails {
	operation: CodeNavigationOperation;
	path: string;
	results: CodeNavigationLocation[];
	truncated: boolean;
	includeExternal: boolean;
}

const DEFAULT_LIMIT = 200;

const DESCRIPTION = `Read-only TypeScript/JavaScript code intelligence.

Operations:
- definition: find the symbol definition at path:line:column.
- references: find references to the symbol at path:line:column.
- hover: show TypeScript quick-info at path:line:column.
- symbols: outline symbols in a file; pass query to filter names.
- diagnostics: show TypeScript syntactic + semantic diagnostics for a file.

Behavior:
- Uses the project's tsconfig.json when present; otherwise builds a single-file JS/TS language service.
- Results are project-local by default. Pass include_external true to include node_modules/.d.ts locations.
- This is read-only and safe to use before editing so the agent can navigate by symbol instead of grep alone.`;

export function createCodeNavigation(ctx: ToolContext): AgentTool<typeof Params, CodeNavigationDetails> {
	return {
		name: "code_navigation",
		label: "Code nav",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			const absPath = resolveFile(ctx.cwd, params.path);
			const limit = params.max_results ?? DEFAULT_LIMIT;
			const includeExternal = params.include_external === true;
			const language = createLanguageContext(ctx.cwd, absPath);

			switch (params.operation) {
				case "definition":
					return runDefinition(ctx.cwd, language, absPath, params, limit, includeExternal);
				case "references":
					return runReferences(ctx.cwd, language, absPath, params, limit, includeExternal);
				case "hover":
					return runHover(ctx.cwd, language, absPath, params, includeExternal);
				case "symbols":
					return runSymbols(ctx.cwd, language, absPath, params, limit, includeExternal);
				case "diagnostics":
					return runDiagnostics(ctx.cwd, language, absPath, limit, includeExternal);
			}
		},
	};
}

interface LanguageContext {
	service: ts.LanguageService;
	sourceFile: ts.SourceFile;
}

function runDefinition(
	cwd: string,
	language: LanguageContext,
	absPath: string,
	params: CodeNavigationParams,
	limit: number,
	includeExternal: boolean,
) {
	const position = positionFromParams(language.sourceFile, params);
	const all = language.service.getDefinitionAtPosition(absPath, position) ?? [];
	const filtered = filterLocations(cwd, all, includeExternal);
	const { items, truncated } = cap(filtered, limit);
	const results = items.flatMap((entry) =>
		locationFromSpan(cwd, language.service, entry.fileName, entry.textSpan, entry),
	);
	return textResult(cwd, "definition", absPath, includeExternal, results, truncated);
}

function runReferences(
	cwd: string,
	language: LanguageContext,
	absPath: string,
	params: CodeNavigationParams,
	limit: number,
	includeExternal: boolean,
) {
	const position = positionFromParams(language.sourceFile, params);
	const symbols = language.service.findReferences(absPath, position) ?? [];
	const all = symbols.flatMap((symbol) => symbol.references);
	const filtered = filterLocations(cwd, all, includeExternal);
	const { items, truncated } = cap(filtered, limit);
	const results = items.flatMap((entry) =>
		locationFromSpan(cwd, language.service, entry.fileName, entry.textSpan, entry),
	);
	return textResult(cwd, "references", absPath, includeExternal, results, truncated);
}

function runHover(
	cwd: string,
	language: LanguageContext,
	absPath: string,
	params: CodeNavigationParams,
	includeExternal: boolean,
) {
	const position = positionFromParams(language.sourceFile, params);
	const info = language.service.getQuickInfoAtPosition(absPath, position);
	if (!info) return textResult(cwd, "hover", absPath, includeExternal, [], false, "No hover information.");
	const display = ts.displayPartsToString(info.displayParts ?? []);
	const docs = ts.displayPartsToString(info.documentation ?? []);
	const tagText = (info.tags ?? [])
		.map((tag) => `@${tag.name}${tag.text ? ` ${tag.text.map((part) => part.text).join("")}` : ""}`)
		.join("\n");
	const text = [display, docs, tagText].filter(Boolean).join("\n\n");
	return {
		content: [{ type: "text" as const, text }],
		details: {
			operation: "hover" as const,
			path: relative(cwd, absPath),
			results: [],
			truncated: false,
			includeExternal,
		},
	};
}

function runSymbols(
	cwd: string,
	language: LanguageContext,
	absPath: string,
	params: CodeNavigationParams,
	limit: number,
	includeExternal: boolean,
) {
	const query = params.query?.trim().toLowerCase();
	const all = flattenSymbols(language.service.getNavigationBarItems(absPath), language.service, cwd, absPath);
	const filtered = query ? all.filter((item) => item.name?.toLowerCase().includes(query)) : all;
	const { items, truncated } = cap(filtered, limit);
	return textResult(cwd, "symbols", absPath, includeExternal, items, truncated);
}

function runDiagnostics(
	cwd: string,
	language: LanguageContext,
	absPath: string,
	limit: number,
	includeExternal: boolean,
) {
	const raw = [
		...language.service.getSyntacticDiagnostics(absPath),
		...language.service.getSemanticDiagnostics(absPath),
	].filter((diag) => includeExternal || !diag.file || isInsideCwd(cwd, diag.file.fileName));
	const all = raw.flatMap((diag) => diagnosticLocation(cwd, language.service, diag));
	const { items, truncated } = cap(all, limit);
	return textResult(cwd, "diagnostics", absPath, includeExternal, items, truncated);
}

function createLanguageContext(cwd: string, absPath: string): LanguageContext {
	const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
	let fileNames: string[];
	let options: ts.CompilerOptions;

	if (configPath) {
		const read = ts.readConfigFile(configPath, ts.sys.readFile);
		if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
		const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
		fileNames = parsed.fileNames.includes(absPath) ? parsed.fileNames : [...parsed.fileNames, absPath];
		options = parsed.options;
	} else {
		fileNames = [absPath];
		options = {
			allowJs: true,
			checkJs: true,
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.Node16,
			moduleResolution: ts.ModuleResolutionKind.Node16,
			jsx: ts.JsxEmit.ReactJSX,
		};
	}

	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => fileNames,
		getScriptVersion: () => "0",
		getScriptSnapshot: (fileName) => {
			if (!existsSync(fileName)) return undefined;
			return ts.ScriptSnapshot.fromString(readFileSync(fileName, "utf8"));
		},
		getCurrentDirectory: () => cwd,
		getCompilationSettings: () => options,
		getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
		realpath: ts.sys.realpath,
		useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
	};
	const service = ts.createLanguageService(host, ts.createDocumentRegistry());
	const program = service.getProgram();
	const sourceFile = program?.getSourceFile(absPath);
	if (!sourceFile) throw new Error(`Cannot load ${relative(cwd, absPath)} in TypeScript language service.`);
	return { service, sourceFile };
}

function resolveFile(cwd: string, path: string): string {
	const absPath = resolveInsideCwd(cwd, path);
	const stat = statSync(absPath);
	if (stat.isDirectory()) throw new Error(`${path} is a directory; pass a TypeScript/JavaScript file path.`);
	return absPath;
}

function positionFromParams(sourceFile: ts.SourceFile, params: CodeNavigationParams): number {
	if (params.line === undefined || params.column === undefined) {
		throw new Error(`${params.operation} requires both line and column.`);
	}
	const line = params.line - 1;
	const column = params.column - 1;
	if (line < 0 || line >= sourceFile.getLineStarts().length) {
		throw new Error(`line ${params.line} is outside ${sourceFile.fileName}.`);
	}
	return sourceFile.getPositionOfLineAndCharacter(line, Math.max(0, column));
}

function filterLocations<T extends { fileName?: string; file?: string }>(
	cwd: string,
	items: readonly T[],
	includeExternal: boolean,
): T[] {
	if (includeExternal) return [...items];
	return items.filter((item) => isInsideCwd(cwd, item.fileName ?? item.file ?? ""));
}

function isInsideCwd(cwd: string, fileName: string): boolean {
	if (!fileName) return false;
	const rel = relative(cwd, fileName);
	return !!rel && !rel.startsWith("..") && !rel.startsWith("/") && rel !== "";
}

function locationFromSpan(
	cwd: string,
	service: ts.LanguageService,
	fileName: string,
	span: ts.TextSpan,
	meta: { kind?: string; name?: string; isDefinition?: boolean },
): CodeNavigationLocation[] {
	const sourceFile = service.getProgram()?.getSourceFile(fileName);
	if (!sourceFile) return [];
	const loc = sourceFile.getLineAndCharacterOfPosition(span.start);
	const line = loc.line + 1;
	return [
		{
			file: relativeOrAbsolute(cwd, fileName),
			line,
			column: loc.character + 1,
			kind: meta.kind,
			name: meta.name,
			isDefinition: meta.isDefinition,
			preview: sourceLine(sourceFile, loc.line),
		},
	];
}

function diagnosticLocation(cwd: string, service: ts.LanguageService, diag: ts.Diagnostic): CodeNavigationLocation[] {
	if (!diag.file || diag.start === undefined) {
		return [
			{
				file: "",
				line: 1,
				column: 1,
				kind: "diagnostic",
				name: `TS${diag.code}`,
				preview: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
			},
		];
	}
	const sourceFile = service.getProgram()?.getSourceFile(diag.file.fileName) ?? diag.file;
	const loc = sourceFile.getLineAndCharacterOfPosition(diag.start);
	return [
		{
			file: relativeOrAbsolute(cwd, sourceFile.fileName),
			line: loc.line + 1,
			column: loc.character + 1,
			kind: diag.category === ts.DiagnosticCategory.Error ? "error" : "warning",
			name: `TS${diag.code}`,
			preview: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
		},
	];
}

function flattenSymbols(
	items: readonly ts.NavigationBarItem[],
	service: ts.LanguageService,
	cwd: string,
	fileName: string,
): CodeNavigationLocation[] {
	return items.flatMap((item) => {
		const span = item.spans[0];
		const here = span ? locationFromSpan(cwd, service, fileName, span, { kind: item.kind, name: item.text }) : [];
		return [...here, ...flattenSymbols(item.childItems ?? [], service, cwd, fileName)];
	});
}

function sourceLine(sourceFile: ts.SourceFile, lineIndex: number): string {
	const text = sourceFile.text;
	const starts = sourceFile.getLineStarts();
	const start = starts[lineIndex] ?? 0;
	const end = starts[lineIndex + 1] ?? text.length;
	return text
		.slice(start, end)
		.replace(/\r?\n$/, "")
		.trim();
}

function relativeOrAbsolute(cwd: string, fileName: string): string {
	const rel = relative(cwd, fileName);
	return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : fileName;
}

function cap<T>(items: readonly T[], limit: number): { items: T[]; truncated: boolean } {
	const truncated = items.length > limit;
	return { items: truncated ? items.slice(0, limit) : [...items], truncated };
}

function textResult(
	cwd: string,
	operation: CodeNavigationOperation,
	absPath: string,
	includeExternal: boolean,
	results: CodeNavigationLocation[],
	truncated: boolean,
	emptyText?: string,
) {
	const text =
		results.length === 0
			? (emptyText ?? `No ${operation} results.`)
			: `${results.length} ${operation} result${results.length === 1 ? "" : "s"}:\n${results.map(formatLocation).join("\n")}${
					truncated ? "\n... (truncated)" : ""
				}`;
	return {
		content: [{ type: "text" as const, text }],
		details: {
			operation,
			path: relativeOrAbsolute(cwd, absPath),
			results,
			truncated,
			includeExternal,
		},
	};
}

function formatLocation(loc: CodeNavigationLocation): string {
	const label = [loc.kind, loc.name].filter(Boolean).join(" ");
	const suffix = label ? ` ${label}` : "";
	const definition = loc.isDefinition ? " [definition]" : "";
	const preview = loc.preview ? ` — ${loc.preview}` : "";
	return `${loc.file}:${loc.line}:${loc.column}${suffix}${definition}${preview}`;
}
