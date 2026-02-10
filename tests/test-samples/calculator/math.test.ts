import { describe, it, expect } from 'vitest';
import { add, subtract, multiply, divide, power, sqrt, factorial } from './math';

describe('add', () => {
  it('should add two positive numbers', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('should add negative numbers', () => {
    expect(add(-5, -3)).toBe(-8);
  });

  it('should add positive and negative numbers', () => {
    expect(add(10, -4)).toBe(6);
  });

  it('should add decimals', () => {
    expect(add(0.1, 0.2)).toBeCloseTo(0.3);
  });
});

describe('subtract', () => {
  it('should subtract two positive numbers', () => {
    expect(subtract(10, 4)).toBe(6);
  });

  it('should handle negative results', () => {
    expect(subtract(3, 8)).toBe(-5);
  });

  it('should subtract negative numbers', () => {
    expect(subtract(5, -3)).toBe(8);
  });
});

describe('multiply', () => {
  it('should multiply two positive numbers', () => {
    expect(multiply(4, 5)).toBe(20);
  });

  it('should multiply by zero', () => {
    expect(multiply(100, 0)).toBe(0);
  });

  it('should multiply negative numbers', () => {
    expect(multiply(-4, 5)).toBe(-20);
  });

  it('should multiply two negative numbers', () => {
    expect(multiply(-4, -5)).toBe(20);
  });

  it('should multiply decimals', () => {
    expect(multiply(0.5, 0.5)).toBe(0.25);
  });
});

describe('divide', () => {
  it('should divide two positive numbers', () => {
    expect(divide(20, 4)).toBe(5);
  });

  it('should divide with remainder', () => {
    expect(divide(10, 3)).toBeCloseTo(3.333);
  });

  it('should throw on division by zero', () => {
    expect(() => divide(10, 0)).toThrow('Division by zero');
  });

  it('should handle negative division', () => {
    expect(divide(-10, 2)).toBe(-5);
  });
});

describe('power', () => {
  it('should raise base to positive exponent', () => {
    expect(power(2, 3)).toBe(8);
  });

  it('should raise base to zero exponent', () => {
    expect(power(5, 0)).toBe(1);
  });

  it('should raise base to negative exponent', () => {
    expect(power(2, -2)).toBe(0.25);
  });

  it('should handle decimal exponents', () => {
    expect(power(4, 0.5)).toBe(2);
  });
});

describe('sqrt', () => {
  it('should calculate square root of perfect square', () => {
    expect(sqrt(16)).toBe(4);
  });

  it('should calculate square root of non-perfect square', () => {
    expect(sqrt(2)).toBeCloseTo(1.414);
  });

  it('should return 0 for sqrt(0)', () => {
    expect(sqrt(0)).toBe(0);
  });

  it('should throw on negative number', () => {
    expect(() => sqrt(-1)).toThrow('Cannot calculate square root of negative number');
  });
});

describe('factorial', () => {
  it('should calculate factorial of 0', () => {
    expect(factorial(0)).toBe(1);
  });

  it('should calculate factorial of 1', () => {
    expect(factorial(1)).toBe(1);
  });

  it('should calculate factorial of positive integers', () => {
    expect(factorial(5)).toBe(120);
  });

  it('should calculate factorial of 10', () => {
    expect(factorial(10)).toBe(3628800);
  });

  it('should throw on negative number', () => {
    expect(() => factorial(-1)).toThrow('Cannot calculate factorial of negative number');
  });
});
