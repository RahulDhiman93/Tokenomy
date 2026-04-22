import { readFileSync } from "node:fs";
import type * as TS from "typescript";
import {
  createClassNode,
  createExportedSymbolNode,
  createExternalModuleNode,
  createFileNode,
  createFunctionNode,
  createImportedSymbolNode,
  createMethodNode,
  createTestFileNode,
  type Confidence,
  type Edge,
  type Graph,
  type Node,
} from "../../graph/schema.js";
import { resolveSpecifier } from "../../graph/resolve.js";
import type { TsconfigResolver } from "../../graph/tsconfig-resolver.js";
import { scriptKindFor } from "./script-kind.js";

export interface ExtractFileResult {
  nodes: Node[];
  edges: Edge[];
  parse_errors: Graph["parse_errors"];
}

interface ExtractionState {
  readonly filePath: string;
  readonly fileNodeId: string;
  readonly files: ReadonlySet<string>;
  readonly sourceFile: TS.SourceFile;
  readonly ts: typeof TS;
  readonly nodes: Node[];
  readonly edges: Edge[];
  readonly parse_errors: Graph["parse_errors"];
  readonly importedByName: Map<string, string>;
  readonly fileImportEdgeKeys: Set<string>;
  readonly testEdgeKeys: Set<string>;
  readonly localSymbolByName: Map<string, string>;
  readonly classMethodsByName: Map<string, Map<string, string>>;
  readonly symbolNodeIdsByAst: WeakMap<TS.Node, string>;
  readonly classNodeIdsByAst: WeakMap<TS.Node, string>;
  readonly methodNodeIdsByAst: WeakMap<TS.Node, string>;
  readonly functionExpressionIdsByAst: WeakMap<TS.Node, string>;
  readonly exportedSymbolByName: Map<string, string>;
  readonly pendingLocalExports: Array<{ exportNodeId: string; localName: string }>;
  readonly nextLineSlot: (name: string, line: number) => number;
  readonly testNodeId?: string;
  // Optional tsconfig-paths resolver. When present, non-relative specifiers
  // try this resolver first; on null it falls through to `resolveSpecifier`
  // (which yields the existing external-module fallback).
  readonly tsconfigResolver?: TsconfigResolver;
}

interface TraversalContext {
  ownerId: string;
  className?: string;
  classMethods?: Map<string, string>;
  shadowed: Set<string>;
}

const isTestFile = (path: string): boolean =>
  /(^|\/)__tests__\//.test(path) || /\.(test|spec)\.[^.]+$/.test(path);

const lineOf = (sourceFile: TS.SourceFile, node: TS.Node): number =>
  sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

const withLineCounter = () => {
  const seen = new Map<string, number>();
  return (name: string, line: number): number => {
    const key = `${name}@${line}`;
    const next = seen.get(key) ?? 0;
    seen.set(key, next + 1);
    return next;
  };
};

const hasModifier = (
  node: TS.Node & { modifiers?: TS.NodeArray<TS.ModifierLike> },
  ts: typeof TS,
  modifier: TS.SyntaxKind,
): boolean => !!node.modifiers?.some((candidate) => candidate.kind === modifier);

const isStringLiteralLike = (
  node: TS.Expression | undefined,
  ts: typeof TS,
): node is TS.StringLiteral | TS.NoSubstitutionTemplateLiteral =>
  !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

const isRequireCall = (node: TS.CallExpression, ts: typeof TS): boolean =>
  ts.isIdentifier(node.expression) &&
  node.expression.text === "require" &&
  node.arguments.length === 1 &&
  isStringLiteralLike(node.arguments[0], ts);

const addContainsEdge = (state: ExtractionState, from: string, to: string): void => {
  state.edges.push({ from, to, kind: "contains", confidence: "definite" });
};

const addEdge = (
  state: ExtractionState,
  from: string,
  to: string,
  kind: Edge["kind"],
  confidence: Confidence,
  via?: string,
): void => {
  state.edges.push({ from, to, kind, confidence, ...(via ? { via } : {}) });
};

const addNode = (state: ExtractionState, node: Node): void => {
  state.nodes.push(node);
};

const resolveTarget = (
  state: ExtractionState,
  specifier: string,
): { id: string; kind: "file" | "external-module" } => {
  // For non-relative specifiers (e.g. `@/hooks/foo`, `react`), try the
  // tsconfig path-alias resolver first. If it returns non-null, the
  // specifier resolved to an in-graph file via `paths`/`baseUrl` — use
  // that. Otherwise fall through to the baseline `resolveSpecifier`, which
  // yields an external-module node (preserves pre-alpha.17 behavior for
  // genuine bare imports like `react`).
  const isRelative = specifier.startsWith(".") || specifier.startsWith("/");
  const target =
    !isRelative && state.tsconfigResolver
      ? state.tsconfigResolver.resolve(state.filePath, specifier) ??
        resolveSpecifier(state.filePath, specifier, state.files)
      : resolveSpecifier(state.filePath, specifier, state.files);
  if (target.kind === "external-module") {
    addNode(state, createExternalModuleNode(target.target));
    return { id: `ext:${target.target}`, kind: "external-module" };
  }

  addNode(state, createFileNode(target.target));
  if (target.kind === "missing-file" && target.message) {
    state.parse_errors.push({ file: state.filePath, message: target.message });
  }
  return { id: `file:${target.target}`, kind: "file" };
};

const addFileImportEdge = (
  state: ExtractionState,
  specifier: string,
  confidence: Confidence,
): { id: string; kind: "file" | "external-module" } => {
  const target = resolveTarget(state, specifier);
  const fileImportKey = `${state.fileNodeId}\u0000${target.id}\u0000${confidence}`;
  if (!state.fileImportEdgeKeys.has(fileImportKey)) {
    state.fileImportEdgeKeys.add(fileImportKey);
    addEdge(state, state.fileNodeId, target.id, "imports", confidence, specifier);
  }
  if (state.testNodeId && target.kind === "file") {
    const testKey = `${state.testNodeId}\u0000${target.id}`;
    if (!state.testEdgeKeys.has(testKey)) {
      state.testEdgeKeys.add(testKey);
      addEdge(state, state.testNodeId, target.id, "tests", "definite", specifier);
    }
  }
  return target;
};

const addImportSymbol = (
  state: ExtractionState,
  localName: string,
  line: number,
  specifier: string,
  confidence: Confidence,
  originalName?: string,
): string => {
  const slot = state.nextLineSlot(localName, line);
  const node = createImportedSymbolNode(state.filePath, localName, line, slot, originalName);
  addNode(state, node);
  addContainsEdge(state, state.fileNodeId, node.id);
  state.importedByName.set(localName, node.id);

  const target = resolveTarget(state, specifier);
  addEdge(state, node.id, target.id, "imports", confidence, specifier);
  addFileImportEdge(state, specifier, confidence);
  return node.id;
};

const addExportSymbol = (state: ExtractionState, exportName: string): string => {
  const node = createExportedSymbolNode(state.filePath, exportName);
  addNode(state, node);
  addContainsEdge(state, state.fileNodeId, node.id);
  state.exportedSymbolByName.set(exportName, node.id);
  return node.id;
};

const addTopLevelFunction = (
  state: ExtractionState,
  node:
    | TS.FunctionDeclaration
    | TS.VariableDeclaration
    | TS.ArrowFunction
    | TS.FunctionExpression,
  name: string,
): string => {
  const line = lineOf(state.sourceFile, node);
  const slot = state.nextLineSlot(name, line);
  const fn = createFunctionNode(
    state.filePath,
    name,
    line,
    slot,
    node.getStart(state.sourceFile),
    node.end,
  );
  addNode(state, fn);
  addContainsEdge(state, state.fileNodeId, fn.id);
  state.localSymbolByName.set(name, fn.id);
  state.symbolNodeIdsByAst.set(node, fn.id);
  return fn.id;
};

const addClassNode = (
  state: ExtractionState,
  node: TS.ClassDeclaration,
  name: string,
): string => {
  const line = lineOf(state.sourceFile, node);
  const slot = state.nextLineSlot(name, line);
  const classNode = createClassNode(
    state.filePath,
    name,
    line,
    slot,
    node.getStart(state.sourceFile),
    node.end,
  );
  addNode(state, classNode);
  addContainsEdge(state, state.fileNodeId, classNode.id);
  state.localSymbolByName.set(name, classNode.id);
  state.symbolNodeIdsByAst.set(node, classNode.id);
  state.classNodeIdsByAst.set(node, classNode.id);
  state.classMethodsByName.set(name, new Map());
  return classNode.id;
};

const addMethodNodeForClass = (
  state: ExtractionState,
  className: string,
  classId: string,
  node: TS.MethodDeclaration,
): void => {
  if (!node.name || !state.ts.isIdentifier(node.name)) return;
  const methodName = node.name.text;
  const line = lineOf(state.sourceFile, node);
  const slot = state.nextLineSlot(`${className}.${methodName}`, line);
  const methodNode = createMethodNode(
    state.filePath,
    className,
    methodName,
    line,
    slot,
    node.getStart(state.sourceFile),
    node.end,
  );
  addNode(state, methodNode);
  addContainsEdge(state, classId, methodNode.id);
  state.symbolNodeIdsByAst.set(node, methodNode.id);
  state.methodNodeIdsByAst.set(node, methodNode.id);
  state.classMethodsByName.get(className)?.set(methodName, methodNode.id);
};

const addVariableFunctionIfPresent = (
  state: ExtractionState,
  node: TS.VariableDeclaration,
  exported: boolean,
): void => {
  if (!state.ts.isIdentifier(node.name) || !node.initializer) return;
  if (!state.ts.isArrowFunction(node.initializer) && !state.ts.isFunctionExpression(node.initializer)) {
    return;
  }

  const fnId = addTopLevelFunction(state, node.initializer, node.name.text);
  state.functionExpressionIdsByAst.set(node.initializer, fnId);
  if (exported) {
    const expId = addExportSymbol(state, node.name.text);
    addEdge(state, expId, fnId, "exports", "definite");
  }
};

const processImportDeclaration = (state: ExtractionState, node: TS.ImportDeclaration): void => {
  const specifier =
    isStringLiteralLike(node.moduleSpecifier, state.ts) ? node.moduleSpecifier.text : null;
  if (!specifier || node.importClause?.isTypeOnly) return;

  const line = lineOf(state.sourceFile, node);
  const importClause = node.importClause;
  if (!importClause?.name && !importClause?.namedBindings) {
    addFileImportEdge(state, specifier, "definite");
    return;
  }

  if (importClause?.name) addImportSymbol(state, importClause.name.text, line, specifier, "definite");
  if (importClause?.namedBindings && state.ts.isNamespaceImport(importClause.namedBindings)) {
    addImportSymbol(
      state,
      importClause.namedBindings.name.text,
      line,
      specifier,
      "definite",
    );
  }
  if (importClause?.namedBindings && state.ts.isNamedImports(importClause.namedBindings)) {
    for (const element of importClause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const localName = element.name.text;
      // For aliased imports (`{ foo as bar }`), propertyName is the original
      // export name (`foo`), name is the local binding (`bar`). Track the
      // original so find_usages can match the defining export, not the local.
      const originalName = element.propertyName?.text ?? localName;
      addImportSymbol(state, localName, line, specifier, "definite", originalName);
    }
  }
};

const processImportEqualsDeclaration = (
  state: ExtractionState,
  node: TS.ImportEqualsDeclaration,
): void => {
  if (!state.ts.isExternalModuleReference(node.moduleReference)) return;
  if (!isStringLiteralLike(node.moduleReference.expression, state.ts)) return;
  addImportSymbol(
    state,
    node.name.text,
    lineOf(state.sourceFile, node),
    node.moduleReference.expression.text,
    "inferred",
  );
};

const processExportDeclaration = (state: ExtractionState, node: TS.ExportDeclaration): void => {
  const specifier =
    node.moduleSpecifier && isStringLiteralLike(node.moduleSpecifier, state.ts)
      ? node.moduleSpecifier.text
      : null;
  if (node.isTypeOnly) return;

  if (!node.exportClause) {
    if (specifier) {
      const target = resolveTarget(state, specifier);
      addEdge(state, state.fileNodeId, target.id, "exports", "inferred", specifier);
      addFileImportEdge(state, specifier, "definite");
    }
    return;
  }

  if (!state.ts.isNamedExports(node.exportClause)) return;
  for (const element of node.exportClause.elements) {
    if (element.isTypeOnly) continue;
    const exportName = element.name.text;
    const localName = element.propertyName?.text ?? element.name.text;
    const exportNodeId = addExportSymbol(state, exportName);
    if (specifier) {
      const target = resolveTarget(state, specifier);
      addEdge(state, exportNodeId, target.id, "exports", "definite", specifier);
      addFileImportEdge(state, specifier, "definite");
    } else {
      state.pendingLocalExports.push({ exportNodeId, localName });
    }
  }
};

const processExportAssignment = (state: ExtractionState, node: TS.ExportAssignment): void => {
  const exportNodeId = addExportSymbol(state, "default");
  if (state.ts.isIdentifier(node.expression)) {
    state.pendingLocalExports.push({ exportNodeId, localName: node.expression.text });
  }
};

const processTopLevelDeclaration = (
  state: ExtractionState,
  stmt: TS.Statement,
): void => {
  if (state.ts.isFunctionDeclaration(stmt) && stmt.name) {
    const fnId = addTopLevelFunction(state, stmt, stmt.name.text);
    if (hasModifier(stmt, state.ts, state.ts.SyntaxKind.ExportKeyword)) {
      const expId = addExportSymbol(state, stmt.name.text);
      addEdge(state, expId, fnId, "exports", "definite");
    }
    return;
  }

  if (state.ts.isClassDeclaration(stmt) && stmt.name) {
    const className = stmt.name.text;
    const classId = addClassNode(state, stmt, className);
    for (const member of stmt.members) {
      if (state.ts.isMethodDeclaration(member)) {
        addMethodNodeForClass(state, className, classId, member);
      }
    }
    if (hasModifier(stmt, state.ts, state.ts.SyntaxKind.ExportKeyword)) {
      const expId = addExportSymbol(state, className);
      addEdge(state, expId, classId, "exports", "definite");
    }
    return;
  }

  if (state.ts.isVariableStatement(stmt)) {
    const exported = hasModifier(stmt, state.ts, state.ts.SyntaxKind.ExportKeyword);
    for (const decl of stmt.declarationList.declarations) {
      addVariableFunctionIfPresent(state, decl, exported);
    }
  }
};

const resolveLocalTarget = (state: ExtractionState, name: string): string | null =>
  state.localSymbolByName.get(name) ??
  state.importedByName.get(name) ??
  null;

const finalizePendingExports = (state: ExtractionState): void => {
  for (const pending of state.pendingLocalExports) {
    const target = resolveLocalTarget(state, pending.localName);
    if (target) addEdge(state, pending.exportNodeId, target, "exports", "definite");
  }
};

const addBindingNames = (name: TS.BindingName, out: Set<string>, ts: typeof TS): void => {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    addBindingNames(element.name, out, ts);
  }
};

const collectLocalNames = (root: TS.Node, ts: typeof TS): Set<string> => {
  const names = new Set<string>();

  const walk = (node: TS.Node): void => {
    if (
      node !== root &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isClassDeclaration(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    if (ts.isParameter(node)) {
      addBindingNames(node.name, names, ts);
    }
    if (ts.isVariableDeclaration(node)) {
      addBindingNames(node.name, names, ts);
    }
    if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text);
    if (ts.isClassDeclaration(node) && node.name) names.add(node.name.text);
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      addBindingNames(node.variableDeclaration.name, names, ts);
    }
    ts.forEachChild(node, walk);
  };

  ts.forEachChild(root, walk);
  return names;
};

const resolveIdentifierTarget = (
  state: ExtractionState,
  name: string,
  ctx: TraversalContext,
): { id: string; confidence: Confidence } | null => {
  if (ctx.shadowed.has(name)) return null;
  const imported = state.importedByName.get(name);
  if (imported) return { id: imported, confidence: "inferred" };
  const local = state.localSymbolByName.get(name);
  if (local) return { id: local, confidence: "definite" };
  return null;
};

const resolvePropertyAccessTarget = (
  state: ExtractionState,
  node: TS.PropertyAccessExpression,
  ctx: TraversalContext,
): { id: string; confidence: Confidence } | null => {
  if (
    node.expression.kind === state.ts.SyntaxKind.ThisKeyword &&
    ctx.classMethods?.has(node.name.text)
  ) {
    return { id: ctx.classMethods.get(node.name.text)!, confidence: "definite" };
  }
  if (state.ts.isIdentifier(node.expression)) {
    if (ctx.shadowed.has(node.expression.text)) return null;
    const imported = state.importedByName.get(node.expression.text);
    if (imported) return { id: imported, confidence: "inferred" };
  }
  return null;
};

const resolveCallTarget = (
  state: ExtractionState,
  expression: TS.LeftHandSideExpression,
  ctx: TraversalContext,
): { id: string; confidence: Confidence } | null => {
  if (state.ts.isIdentifier(expression)) {
    return resolveIdentifierTarget(state, expression.text, ctx);
  }
  if (state.ts.isPropertyAccessExpression(expression)) {
    return resolvePropertyAccessTarget(state, expression, ctx);
  }
  return null;
};

const shouldSkipIdentifierReference = (
  ts: typeof TS,
  parent: TS.Node | undefined,
  node: TS.Identifier,
): boolean => {
  if (!parent) return false;
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isExportSpecifier(parent)) &&
    "name" in parent &&
    (parent as { name?: TS.Node }).name === node
  ) {
    return true;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  return false;
};

const walkSemantic = (
  state: ExtractionState,
  node: TS.Node,
  parent: TS.Node | undefined,
  ctx: TraversalContext,
): void => {
  let nextContext = ctx;

  if (state.ts.isClassDeclaration(node) && node.name) {
    nextContext = {
      ownerId: state.classNodeIdsByAst.get(node) ?? ctx.ownerId,
      className: node.name.text,
      classMethods: state.classMethodsByName.get(node.name.text),
      shadowed: new Set(ctx.shadowed),
    };
  } else if (state.ts.isMethodDeclaration(node)) {
    const ownerId = state.methodNodeIdsByAst.get(node);
    if (ownerId) {
      nextContext = {
        ownerId,
        className: ctx.className,
        classMethods: ctx.classMethods,
        shadowed: collectLocalNames(node, state.ts),
      };
    }
  } else if (state.ts.isFunctionDeclaration(node) || state.ts.isFunctionExpression(node) || state.ts.isArrowFunction(node)) {
    const ownerId =
      state.symbolNodeIdsByAst.get(node) ??
      state.functionExpressionIdsByAst.get(node) ??
      ctx.ownerId;
    if (ownerId !== ctx.ownerId || state.functionExpressionIdsByAst.has(node)) {
      nextContext = {
        ownerId,
        className: ctx.className,
        classMethods: ctx.classMethods,
        shadowed: collectLocalNames(node, state.ts),
      };
    }
  } else if (
    state.ts.isVariableDeclaration(node) &&
    node.initializer &&
    (state.ts.isArrowFunction(node.initializer) || state.ts.isFunctionExpression(node.initializer))
  ) {
    const ownerId = state.functionExpressionIdsByAst.get(node.initializer);
    if (ownerId) {
      nextContext = {
        ownerId,
        className: ctx.className,
        classMethods: ctx.classMethods,
        shadowed: collectLocalNames(node.initializer, state.ts),
      };
    }
  }

  if (state.ts.isCallExpression(node)) {
    if (isRequireCall(node, state.ts)) {
      const specifierArg = node.arguments[0];
      let localName: string | null = null;
      let localNameLine: number | null = null;
      if (parent && state.ts.isVariableDeclaration(parent) && state.ts.isIdentifier(parent.name)) {
        localName = parent.name.text;
        localNameLine = lineOf(state.sourceFile, parent);
      }
      if (
        localName &&
        localNameLine !== null &&
        specifierArg &&
        isStringLiteralLike(specifierArg, state.ts) &&
        !state.importedByName.has(localName)
      ) {
        addImportSymbol(
          state,
          localName,
          localNameLine,
          specifierArg.text,
          "inferred",
        );
      } else if (specifierArg && isStringLiteralLike(specifierArg, state.ts)) {
        addFileImportEdge(state, specifierArg.text, "inferred");
      }
    }
    const callTarget = resolveCallTarget(state, node.expression, nextContext);
    if (callTarget) addEdge(state, nextContext.ownerId, callTarget.id, "calls", callTarget.confidence);
    if (
      node.expression.kind === state.ts.SyntaxKind.ImportKeyword &&
      isStringLiteralLike(node.arguments[0], state.ts)
    ) {
      addFileImportEdge(state, node.arguments[0].text, "inferred");
    }
  }

  if (
    state.ts.isIdentifier(node) &&
    !shouldSkipIdentifierReference(state.ts, parent, node)
  ) {
    const target = resolveIdentifierTarget(state, node.text, nextContext);
    if (target) addEdge(state, nextContext.ownerId, target.id, "references", target.confidence);
  }

  if (state.ts.isPropertyAccessExpression(node) && (!parent || !state.ts.isCallExpression(parent) || parent.expression !== node)) {
    const target = resolvePropertyAccessTarget(state, node, nextContext);
    if (target) addEdge(state, nextContext.ownerId, target.id, "references", target.confidence);
  }

  state.ts.forEachChild(node, (child) => walkSemantic(state, child, node, nextContext));
};

export const extractTsFileGraph = (
  filePath: string,
  sourceText: string,
  files: ReadonlySet<string>,
  ts: typeof TS,
  tsconfigResolver?: TsconfigResolver,
): ExtractFileResult => {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    scriptKindFor(filePath, ts),
  );

  const state: ExtractionState = {
    filePath,
    fileNodeId: `file:${filePath}`,
    files,
    sourceFile,
    ts,
    nodes: [createFileNode(filePath)],
    edges: [],
    parse_errors: [],
    importedByName: new Map(),
    fileImportEdgeKeys: new Set(),
    testEdgeKeys: new Set(),
    localSymbolByName: new Map(),
    classMethodsByName: new Map(),
    symbolNodeIdsByAst: new WeakMap(),
    classNodeIdsByAst: new WeakMap(),
    methodNodeIdsByAst: new WeakMap(),
    functionExpressionIdsByAst: new WeakMap(),
    exportedSymbolByName: new Map(),
    pendingLocalExports: [],
    nextLineSlot: withLineCounter(),
    ...(isTestFile(filePath) ? { testNodeId: `test:${filePath}` } : {}),
    ...(tsconfigResolver ? { tsconfigResolver } : {}),
  };

  if (state.testNodeId) {
    addNode(state, createTestFileNode(filePath));
    addEdge(state, state.testNodeId, state.fileNodeId, "tests", "definite");
  }

  const parseDiagnostics =
    (sourceFile as TS.SourceFile & { parseDiagnostics?: readonly TS.DiagnosticWithLocation[] })
      .parseDiagnostics ?? [];
  for (const diag of parseDiagnostics) {
    state.parse_errors.push({
      file: filePath,
      message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
    });
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      processImportDeclaration(state, stmt);
      continue;
    }
    if (ts.isImportEqualsDeclaration(stmt)) {
      processImportEqualsDeclaration(state, stmt);
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      processExportDeclaration(state, stmt);
      continue;
    }
    if (ts.isExportAssignment(stmt)) {
      processExportAssignment(state, stmt);
      continue;
    }
    processTopLevelDeclaration(state, stmt);
  }

  finalizePendingExports(state);
  walkSemantic(state, sourceFile, undefined, {
    ownerId: state.fileNodeId,
    shadowed: new Set(),
  });

  return {
    nodes: state.nodes,
    edges: state.edges,
    parse_errors: state.parse_errors,
  };
};

export const extractTsFileGraphFromDisk = (
  filePath: string,
  files: ReadonlySet<string>,
  ts: typeof TS,
  tsconfigResolver?: TsconfigResolver,
): ExtractFileResult =>
  extractTsFileGraph(filePath, readFileSync(filePath, "utf8"), files, ts, tsconfigResolver);
