import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateArithmetic } from './arithmetic.ts';

describe('evaluateArithmetic', () => {
  test('respects operator precedence', () => {
    assert.equal(evaluateArithmetic('2+3*4'), 14);
    assert.equal(evaluateArithmetic('20/4-1'), 4);
    assert.equal(evaluateArithmetic('2*3+4*5'), 26);
  });

  test('handles decimals, unary minus and float noise', () => {
    assert.equal(evaluateArithmetic('0.1+0.2'), 0.3);
    assert.equal(evaluateArithmetic('-3*-2'), 6);
    assert.equal(evaluateArithmetic('.5*4'), 2);
  });

  test('rejects malformed input and division by zero', () => {
    for (const input of ['', '2+', '*3', '1..2', '4/0', 'alert(1)', '2**3', '1+(2)']) {
      assert.equal(evaluateArithmetic(input), null, input);
    }
  });
});
