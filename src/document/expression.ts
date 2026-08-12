// A small, safe arithmetic expression evaluator (no eval()). Supports + - * / ^,
// parentheses, unary +/-, numeric literals, named variables from a scope, a few
// constants (pi, e, tau), and common math functions. Trig is in radians.

export type Scope = Record<string, number>;

const CONSTANTS: Scope = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  exp: Math.exp,
  log: Math.log,
  // degrees <-> radians helpers, handy for CAD angles
  rad: (d) => (d * Math.PI) / 180,
  deg: (r) => (r * 180) / Math.PI,
};

interface Token {
  type: "num" | "id" | "op" | "lparen" | "rparen" | "comma";
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const isDigit = (c: string) => c >= "0" && c <= "9";
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
    } else if (isDigit(c) || (c === "." && isDigit(input[i + 1]))) {
      let j = i + 1;
      while (j < input.length && (isDigit(input[j]) || input[j] === ".")) j++;
      tokens.push({ type: "num", value: input.slice(i, j) });
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
      tokens.push({ type: "id", value: input.slice(i, j) });
      i = j;
    } else if ("+-*/^".includes(c)) {
      tokens.push({ type: "op", value: c });
      i++;
    } else if (c === "(") {
      tokens.push({ type: "lparen", value: c });
      i++;
    } else if (c === ")") {
      tokens.push({ type: "rparen", value: c });
      i++;
    } else if (c === ",") {
      tokens.push({ type: "comma", value: c });
      i++;
    } else {
      throw new Error(`Unexpected character "${c}"`);
    }
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private tokens: Token[],
    private scope: Scope,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  parse(): number {
    const value = this.expression();
    if (this.pos !== this.tokens.length) {
      throw new Error(`Unexpected "${this.peek()?.value}"`);
    }
    return value;
  }

  private expression(): number {
    let v = this.term();
    let t = this.peek();
    while (t?.type === "op" && (t.value === "+" || t.value === "-")) {
      this.next();
      const r = this.term();
      v = t.value === "+" ? v + r : v - r;
      t = this.peek();
    }
    return v;
  }

  private term(): number {
    let v = this.unary();
    let t = this.peek();
    while (t?.type === "op" && (t.value === "*" || t.value === "/")) {
      this.next();
      const r = this.unary();
      v = t.value === "*" ? v * r : v / r;
      t = this.peek();
    }
    return v;
  }

  private unary(): number {
    const t = this.peek();
    if (t?.type === "op" && (t.value === "-" || t.value === "+")) {
      this.next();
      const v = this.unary();
      return t.value === "-" ? -v : v;
    }
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    if (this.peek()?.type === "op" && this.peek()?.value === "^") {
      this.next();
      return Math.pow(base, this.unary()); // right-associative
    }
    return base;
  }

  private primary(): number {
    const t = this.next();
    if (!t) throw new Error("Unexpected end of expression");
    if (t.type === "num") return parseFloat(t.value);
    if (t.type === "lparen") {
      const v = this.expression();
      const close = this.next();
      if (close?.type !== "rparen") throw new Error('Expected ")"');
      return v;
    }
    if (t.type === "id") {
      if (this.peek()?.type === "lparen") {
        this.next();
        const args: number[] = [];
        if (this.peek()?.type !== "rparen") {
          args.push(this.expression());
          while (this.peek()?.type === "comma") {
            this.next();
            args.push(this.expression());
          }
        }
        const close = this.next();
        if (close?.type !== "rparen") throw new Error('Expected ")"');
        const fn = FUNCTIONS[t.value];
        if (!fn) throw new Error(`Unknown function "${t.value}"`);
        return fn(...args);
      }
      if (t.value in CONSTANTS) return CONSTANTS[t.value];
      if (t.value in this.scope) return this.scope[t.value];
      throw new Error(`Unknown name "${t.value}"`);
    }
    throw new Error(`Unexpected "${t.value}"`);
  }
}

/** Names that can't be used as variable names: built-in constants and functions
 *  (using one would shadow it and break expressions that rely on it). */
export const RESERVED_NAMES = new Set([...Object.keys(CONSTANTS), ...Object.keys(FUNCTIONS)]);

export function evaluateExpression(expr: string, scope: Scope = {}): number {
  const value = new Parser(tokenize(expr), scope).parse();
  if (!Number.isFinite(value)) throw new Error("Result is not a finite number");
  return value;
}
