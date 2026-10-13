// A small expression language for breakpoint conditions, the Watch and Debug
// Console panes, and MCP's `evaluate`: what a 6502 programmer wants to ask of a
// stopped machine, and nothing more.
//
//   Numbers   &1900  $1900  0x1900  %1010  6400
//   Names     A X Y S P PC (any case), the flags C Z I D V N, and any symbol
//   Memory    ?addr is the byte at addr, peekw(addr) the little-endian word
//   Operators + - * / MOD  & | ^ ~  << >>  == != < <= > >=  && || !  ( )
//             and BBC BASIC's spellings: = <> AND OR EOR NOT. Since &12 is a
//             number, write `A AND &F0` or `A & &F0`, not `A&F0`.
//
// `?` binds like a unary operator, so `?&70+1` is (?&70)+1 and `?(&70+1)`
// the byte after it.

const RegisterNames = new Set(["a", "x", "y", "s", "sp", "p", "pc"]);
const FlagBits = { c: 0x01, z: 0x02, i: 0x04, d: 0x08, b: 0x10, v: 0x40, n: 0x80 };

export function parseNumber(text) {
    const t = String(text).trim();
    let m;
    if ((m = /^[&$]([0-9a-f]+)$/i.exec(t))) return parseInt(m[1], 16);
    if ((m = /^0x([0-9a-f]+)$/i.exec(t))) return parseInt(m[1], 16);
    if ((m = /^%([01]+)$/.exec(t))) return parseInt(m[1], 2);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    return undefined;
}

function tokenise(text) {
    const tokens = [];
    const re =
        /\s*(?:(&[0-9a-f]+|\$[0-9a-f]+|0x[0-9a-f]+|%[01]+|\d+)|([A-Za-z_.@][\w.@]*)|(<<|>>|==|!=|<>|<=|>=|&&|\|\||[-+*/&|^~!?()<>=,]))/giy;
    let pos = 0;
    while (pos < text.length) {
        if (/^\s*$/.test(text.slice(pos))) break;
        re.lastIndex = pos;
        const m = re.exec(text);
        if (!m) throw new Error(`Can't read the expression at "${text.slice(pos)}"`);
        pos = re.lastIndex;
        if (m[1] !== undefined) tokens.push({ kind: "num", value: parseNumber(m[1]) });
        else if (m[2] !== undefined) tokens.push({ kind: "name", value: m[2] });
        else tokens.push({ kind: "op", value: m[3] });
    }
    return tokens;
}

// Binary operators, loosest first.
const Levels = [
    ["||"],
    ["&&"],
    ["|", "OR"],
    ["^", "EOR"],
    ["&", "AND"],
    ["==", "!=", "=", "<>"],
    ["<", "<=", ">", ">="],
    ["<<", ">>"],
    ["+", "-"],
    ["*", "/", "MOD"],
];

/**
 * Compile an expression to a function of a context:
 *   { register(name) -> number, peek(addr) -> byte, symbol(name) -> number|undefined }
 */
export function compile(text) {
    const tokens = tokenise(text);
    let i = 0;
    const peekTok = () => tokens[i];
    const isOp = (v) => {
        const t = tokens[i];
        if (!t) return false;
        if (t.kind === "op" && t.value === v) return true;
        return /^[A-Z]+$/.test(v) && t.kind === "name" && t.value.toUpperCase() === v;
    };

    function binary(level) {
        if (level === Levels.length) return unary();
        let left = binary(level + 1);
        for (;;) {
            const op = Levels[level].find(isOp);
            if (!op) return left;
            i++;
            const right = binary(level + 1);
            const l = left;
            left = (ctx) => apply(op, l(ctx), right(ctx));
        }
    }

    function unary() {
        if (isOp("-")) {
            i++;
            const e = unary();
            return (ctx) => -e(ctx);
        }
        if (isOp("+")) {
            i++;
            return unary();
        }
        if (isOp("!") || isOp("NOT")) {
            i++;
            const e = unary();
            return (ctx) => (e(ctx) ? 0 : 1);
        }
        if (isOp("~")) {
            i++;
            const e = unary();
            return (ctx) => ~e(ctx) & 0xffff;
        }
        if (isOp("?")) {
            i++;
            const e = unary();
            return (ctx) => ctx.peek(e(ctx) & 0xffff);
        }
        return primary();
    }

    function primary() {
        const t = peekTok();
        if (!t) throw new Error("The expression ends too soon");
        if (t.kind === "num") {
            i++;
            return () => t.value;
        }
        if (isOp("(")) {
            i++;
            const e = binary(0);
            if (!isOp(")")) throw new Error("Missing )");
            i++;
            return e;
        }
        if (t.kind === "name") {
            i++;
            const lower = t.value.toLowerCase();
            if (isOp("(") && (lower === "peek" || lower === "peekw")) {
                i++;
                const e = binary(0);
                if (!isOp(")")) throw new Error("Missing )");
                i++;
                if (lower === "peek") return (ctx) => ctx.peek(e(ctx) & 0xffff);
                return (ctx) => {
                    const a = e(ctx) & 0xffff;
                    return ctx.peek(a) | (ctx.peek((a + 1) & 0xffff) << 8);
                };
            }
            const name = t.value;
            return (ctx) => {
                const sym = ctx.symbol?.(name);
                if (sym !== undefined) return sym;
                if (RegisterNames.has(lower)) return ctx.register(lower === "sp" ? "s" : lower);
                if (lower in FlagBits) return ctx.register("p") & FlagBits[lower] ? 1 : 0;
                throw new Error(`Unknown name "${name}"`);
            };
        }
        throw new Error(`Unexpected "${t.value}"`);
    }

    const result = binary(0);
    if (i !== tokens.length) throw new Error(`Unexpected "${tokens[i].value}"`);
    return result;
}

function apply(op, a, b) {
    switch (op) {
        case "||":
            return a || b ? 1 : 0;
        case "&&":
            return a && b ? 1 : 0;
        case "|":
        case "OR":
            return a | b;
        case "^":
        case "EOR":
            return a ^ b;
        case "&":
        case "AND":
            return a & b;
        case "==":
        case "=":
            return a === b ? 1 : 0;
        case "!=":
        case "<>":
            return a !== b ? 1 : 0;
        case "<":
            return a < b ? 1 : 0;
        case "<=":
            return a <= b ? 1 : 0;
        case ">":
            return a > b ? 1 : 0;
        case ">=":
            return a >= b ? 1 : 0;
        case "<<":
            return a << b;
        case ">>":
            return a >>> b;
        case "+":
            return a + b;
        case "-":
            return a - b;
        case "*":
            return a * b;
        case "/":
            if (b === 0) throw new Error("Division by zero");
            return Math.trunc(a / b);
        case "MOD":
            if (b === 0) throw new Error("Division by zero");
            return a % b;
    }
    throw new Error(`Unknown operator ${op}`);
}

export function evaluate(text, ctx) {
    return compile(text)(ctx);
}
