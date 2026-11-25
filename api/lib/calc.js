// api/lib/calc.js
// Calculatrice exacte et SÛRE (analyseur maison, aucun eval) : les modèles se trompent en
// arithmétique de tête, cet outil non.

const FUNCS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, ln: Math.log, log: Math.log10, log10: Math.log10,
  log2: Math.log2, exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max, pow: Math.pow
};
const CONSTS = { pi: Math.PI, e: Math.E };

function tokenize(src) {
  const out = [];
  const re = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)|(\*\*|[-+*/^%(),])|([a-z_][a-z0-9_]*))/iy;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(pos))) break;
      throw new Error(`caractère inattendu près de « ${src.slice(pos, pos + 8).trim()} »`);
    }
    if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: 'op', v: m[2] === '**' ? '^' : m[2] });
    else out.push({ t: 'id', v: m[3].toLowerCase() });
    pos = re.lastIndex;
  }
  return out;
}

function evaluate(expression) {
  const src = String(expression || '').trim().replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
  if (!src) throw new Error('expression vide');
  if (src.length > 200) throw new Error('expression trop longue');
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;

  function parseExpr() {
    let v = parseTerm();
    while (isOp('+') || isOp('-')) { const op = take().v; const r = parseTerm(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  function parseTerm() {
    let v = parseUnary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = take().v; const r = parseUnary();
      if (op === '*') v *= r;
      else if (op === '/') { if (r === 0) throw new Error('division par zéro'); v /= r; }
      else { if (r === 0) throw new Error('modulo par zéro'); v %= r; }
    }
    return v;
  }
  function parseUnary() {
    if (isOp('-')) { take(); return -parseUnary(); }
    if (isOp('+')) { take(); return parseUnary(); }
    return parsePower();
  }
  function parsePower() {
    const base = parsePrimary();
    if (isOp('^')) { take(); return Math.pow(base, parseUnary()); }
    return base;
  }
  function parsePrimary() {
    const tok = take();
    if (!tok) throw new Error('expression incomplète');
    if (tok.t === 'num') return tok.v;
    if (tok.t === 'op' && tok.v === '(') {
      const v = parseExpr();
      if (!isOp(')')) throw new Error('parenthèse fermante manquante');
      take();
      return v;
    }
    if (tok.t === 'id') {
      if (isOp('(')) {
        take();
        const args = [];
        if (!isOp(')')) { args.push(parseExpr()); while (isOp(',')) { take(); args.push(parseExpr()); } }
        if (!isOp(')')) throw new Error('parenthèse fermante manquante');
        take();
        const fn = FUNCS[tok.v];
        if (!fn) throw new Error(`fonction inconnue : ${tok.v}`);
        return fn(...args);
      }
      if (tok.v in CONSTS) return CONSTS[tok.v];
      throw new Error(`symbole inconnu : ${tok.v}`);
    }
    throw new Error(`opérateur inattendu : ${tok.v}`);
  }

  const value = parseExpr();
  if (i < toks.length) throw new Error('expression mal formée');
  if (!Number.isFinite(value)) throw new Error('résultat non défini ou infini');
  return value;
}

function formatNumber(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  return String(Number(n.toPrecision(12)));
}

module.exports = { evaluate, formatNumber };
