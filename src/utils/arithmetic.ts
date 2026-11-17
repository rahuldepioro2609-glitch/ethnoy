/**
 * Evaluates + - * / expressions with decimals, unary minus and correct precedence,
 * without eval/Function (which the production Content-Security-Policy blocks).
 * Returns null for malformed input or division by zero.
 */
export function evaluateArithmetic(input: string): number | null {
  const source = input.replace(/\s+/g, '');
  if (!source || /[^0-9+\-*/.]/.test(source)) return null;
  let position = 0;

  const parseNumber = (): number | null => {
    const match = /^\d*\.?\d+|^\d+\./.exec(source.slice(position));
    if (!match) return null;
    position += match[0].length;
    return Number(match[0]);
  };

  const parseFactor = (): number | null => {
    if (source[position] === '-' || source[position] === '+') {
      const sign = source[position] === '-' ? -1 : 1;
      position += 1;
      const value = parseFactor();
      return value === null ? null : sign * value;
    }
    return parseNumber();
  };

  const parseTerm = (): number | null => {
    let value = parseFactor();
    while (value !== null && (source[position] === '*' || source[position] === '/')) {
      const operator = source[position];
      position += 1;
      const right = parseFactor();
      if (right === null || (operator === '/' && right === 0)) return null;
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  };

  let value = parseTerm();
  while (value !== null && (source[position] === '+' || source[position] === '-')) {
    const operator = source[position];
    position += 1;
    const right = parseTerm();
    if (right === null) return null;
    value = operator === '+' ? value + right : value - right;
  }
  if (value === null || position !== source.length || !Number.isFinite(value)) return null;
  // Trim floating-point noise such as 0.1 + 0.2 = 0.30000000000000004.
  return Number.parseFloat(value.toPrecision(12));
}
