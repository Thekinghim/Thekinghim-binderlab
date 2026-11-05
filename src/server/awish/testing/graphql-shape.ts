/**
 * Liten GraphQL-läsare för låtsas-panelen: tolkar ett operationsdokument (utan fragment,
 * som panelens egna) och jämför det med panelens dokument. Bara för tester.
 *
 * Reglerna är desamma som en GraphQL-server tillämpar mot schemat, men med panelens
 * dokument som schema:
 *  - samma operationstyp och namn,
 *  - exakt samma variabler med samma typer,
 *  - samma rotfält med samma argument,
 *  - ett fält som är skalärt i panelen får inget urval (riktiga Awish nekade det),
 *  - ett fält med urval i panelen måste ha ett urval, och bara fält som panelen frågar
 *    efter (eller som visats fungera mot riktiga Awish, `extras`) får finnas med.
 */

export interface GqlField {
  name: string;
  alias: string | null;
  /** Argument som rå text: namn → "$variabel" eller literal. */
  args: Record<string, string>;
  selections: GqlField[] | null;
}

export interface GqlOperation {
  operation: "query" | "mutation";
  name: string;
  variables: Record<string, string>;
  selections: GqlField[];
}

export class GqlShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GqlShapeError";
  }
}

type Token = { kind: "punct" | "name" | "string" | "number" | "spread"; value: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/[\s,﻿]/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (src.startsWith("...", i)) {
      out.push({ kind: "spread", value: "..." });
      i += 3;
      continue;
    }
    if ("{}()[]:!$=@".includes(c)) {
      out.push({ kind: "punct", value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out.push({ kind: "string", value: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i));
    if (name) {
      out.push({ kind: "name", value: name[0] });
      i += name[0].length;
      continue;
    }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ kind: "number", value: num[0] });
      i += num[0].length;
      continue;
    }
    throw new GqlShapeError(`Syntax Error: Unexpected character "${c}".`);
  }
  return out;
}

export function parseOperation(src: string): GqlOperation {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const next = () => {
    const tok = t[i];
    if (!tok) throw new GqlShapeError("Syntax Error: Unexpected <EOF>.");
    i += 1;
    return tok;
  };
  const expect = (value: string) => {
    const tok = next();
    if (tok.value !== value) {
      throw new GqlShapeError(`Syntax Error: Expected "${value}", found "${tok.value}".`);
    }
  };
  const name = () => {
    const tok = next();
    if (tok.kind !== "name")
      throw new GqlShapeError(`Syntax Error: Expected Name, found "${tok.value}".`);
    return tok.value;
  };
  const type = (): string => {
    let s: string;
    if (peek()?.value === "[") {
      next();
      s = `[${type()}]`;
      expect("]");
    } else {
      s = name();
    }
    if (peek()?.value === "!") {
      next();
      s += "!";
    }
    return s;
  };
  const value = (): string => {
    const tok = next();
    if (tok.value === "$") return `$${name()}`;
    if (tok.value === "[") {
      const items: string[] = [];
      while (peek()?.value !== "]") items.push(value());
      next();
      return `[${items.join(",")}]`;
    }
    if (tok.value === "{") {
      const fields: string[] = [];
      while (peek()?.value !== "}") {
        const k = name();
        expect(":");
        fields.push(`${k}:${value()}`);
      }
      next();
      return `{${fields.join(",")}}`;
    }
    return tok.value;
  };
  const selectionSet = (): GqlField[] => {
    expect("{");
    const fields: GqlField[] = [];
    while (peek()?.value !== "}") {
      if (peek()?.kind === "spread") throw new GqlShapeError("Fragments are not supported.");
      let fieldName = name();
      let alias: string | null = null;
      if (peek()?.value === ":") {
        next();
        alias = fieldName;
        fieldName = name();
      }
      const args: Record<string, string> = {};
      if (peek()?.value === "(") {
        next();
        while (peek()?.value !== ")") {
          const k = name();
          expect(":");
          args[k] = value();
        }
        next();
      }
      if (peek()?.value === "@") throw new GqlShapeError("Directives are not supported.");
      const selections = peek()?.value === "{" ? selectionSet() : null;
      fields.push({ name: fieldName, alias, args, selections });
    }
    next();
    if (fields.length === 0) throw new GqlShapeError('Syntax Error: Expected Name, found "}".');
    return fields;
  };

  const opTok = next();
  if (opTok.value !== "query" && opTok.value !== "mutation") {
    throw new GqlShapeError(`Syntax Error: Unexpected "${opTok.value}".`);
  }
  const opName = peek()?.kind === "name" ? name() : "";
  const variables: Record<string, string> = {};
  if (peek()?.value === "(") {
    next();
    while (peek()?.value !== ")") {
      expect("$");
      const v = name();
      expect(":");
      variables[v] = type();
      if (peek()?.value === "=") throw new GqlShapeError("Default values are not supported.");
    }
    next();
  }
  const selections = selectionSet();
  if (i !== t.length)
    throw new GqlShapeError("This anonymous operation must be the only defined operation.");
  return { operation: opTok.value, name: opName, variables, selections };
}

function sameArgs(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, idx) => k === kb[idx] && a[k] === b[k]);
}

function checkSelections(
  sent: GqlField[],
  real: GqlField[],
  path: string,
  extras: Record<string, readonly string[]>,
): void {
  const allowedExtra = extras[path] ?? [];
  for (const f of sent) {
    const r = real.find((x) => x.name === f.name);
    const here = path ? `${path}.${f.name}` : f.name;
    if (!r) {
      if (
        allowedExtra.includes(f.name) &&
        f.selections === null &&
        Object.keys(f.args).length === 0
      ) {
        continue;
      }
      throw new GqlShapeError(`Cannot query field "${f.name}" on type "${path || "root"}".`);
    }
    if (!sameArgs(f.args, r.args)) {
      throw new GqlShapeError(`Field "${here}" has wrong arguments.`);
    }
    if (r.selections === null && f.selections !== null) {
      throw new GqlShapeError(
        `Field "${f.name}" must not have a selection since type "Scalar" has no subfields.`,
      );
    }
    if (r.selections !== null && f.selections === null) {
      throw new GqlShapeError(
        `Field "${f.name}" of type "Object" must have a selection of subfields.`,
      );
    }
    if (r.selections && f.selections) checkSelections(f.selections, r.selections, here, extras);
  }
}

/** Kastar GqlShapeError om `sent` inte har samma form som panelens dokument `real`. */
export function checkOperationShape(
  sentSrc: string,
  realSrc: string,
  extras: Record<string, readonly string[]> = {},
): GqlOperation {
  const sent = parseOperation(sentSrc);
  const real = parseOperation(realSrc);
  if (sent.operation !== real.operation || sent.name !== real.name) {
    throw new GqlShapeError(
      `Expected ${real.operation} ${real.name}, got ${sent.operation} ${sent.name}.`,
    );
  }
  const sv = Object.keys(sent.variables).sort();
  const rv = Object.keys(real.variables).sort();
  for (const v of rv) {
    if (!(v in sent.variables)) {
      throw new GqlShapeError(`Variable "$${v}" of type "${real.variables[v]}" is not defined.`);
    }
    if (sent.variables[v] !== real.variables[v]) {
      throw new GqlShapeError(
        `Variable "$${v}" of type "${sent.variables[v]}" used in position expecting type "${real.variables[v]}".`,
      );
    }
  }
  for (const v of sv) {
    if (!(v in real.variables)) throw new GqlShapeError(`Variable "$${v}" is never used.`);
  }
  for (const f of sent.selections) {
    if (!real.selections.some((r) => r.name === f.name)) {
      throw new GqlShapeError(`Cannot query field "${f.name}" on type "${real.operation}".`);
    }
  }
  checkSelections(sent.selections, real.selections, "", extras);
  return sent;
}

/** Svarar bara med de fält som frågades efter (som en riktig GraphQL-server). */
export function project(value: unknown, selections: GqlField[] | null): unknown {
  if (selections === null || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((v) => project(v, selections));
  if (typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of selections) out[f.alias ?? f.name] = project(src[f.name], f.selections);
  return out;
}
