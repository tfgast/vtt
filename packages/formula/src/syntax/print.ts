import type { Expr } from "./ast";
import { isKeyword } from "./tokens";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function printName(name: string): string {
  return IDENTIFIER.test(name) && !isKeyword(name) ? name : `\`${name}\``;
}

function printText(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * A compact s-expression for an AST, for tests and debugging:
 *
 * - literals print as source (`12`, `"hi"`, `true`, `empty`, `all`, `gm`,
 *   `this`, `it`); dice as `(dice 2d6)`
 * - names print bare, or backticked when not a plain identifier
 * - `(neg x)`, `(not x)`, `(+ a b)`; a chained comparison adds `:chained`
 * - `(. target name)`, `(call f args...)`, `(.where target arg)`,
 *   `(.sort target arg)`, `(.sort target arg desc)`
 * - `(list items...)`, `(record (name value)...)`
 */
export function printAst(node: Expr): string {
  switch (node.kind) {
    case "Number":
      return String(node.value);
    case "Text":
      return printText(node.value);
    case "Boolean":
      return String(node.value);
    case "Empty":
      return "empty";
    case "Dice":
      return `(dice ${node.raw})`;
    case "Viewer":
      return node.which;
    case "This":
      return "this";
    case "It":
      return "it";
    case "Name":
      return printName(node.name);
    case "List":
      return sexpr("list", ...node.items.map(printAst));
    case "Record":
      return sexpr("record", ...node.fields.map(([k, v]) => `(${printName(k)} ${printAst(v)})`));
    case "Unary":
      return sexpr(node.op === "-" ? "neg" : "not", printAst(node.operand));
    case "Binary": {
      const parts = [printAst(node.left), printAst(node.right)];
      return sexpr(node.op, ...parts, ...(node.chained ? [":chained"] : []));
    }
    case "Dot":
      return sexpr(".", printAst(node.target), printName(node.name));
    case "Call":
      return sexpr("call", node.name, ...node.args.map(printAst));
    case "Method":
      return sexpr(
        `.${node.name}`,
        printAst(node.target),
        ...node.args.map(printAst),
        ...(node.desc ? ["desc"] : []),
      );
  }
}

function sexpr(head: string, ...parts: string[]): string {
  return `(${[head, ...parts].join(" ")})`;
}
