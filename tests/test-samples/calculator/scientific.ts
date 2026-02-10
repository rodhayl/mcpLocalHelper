/**
 * Scientific mathematical functions with comprehensive edge case handling.
 */

/**
 * Calculates the sine of an angle in radians.
 * @param value - The angle in radians.
 * @returns The sine of the angle.
 * @throws Error if the value is not a finite number.
 */
export function sin(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Input must be a finite number');
  }
  return Math.sin(value);
}

/**
 * Calculates the cosine of an angle in radians.
 * @param value - The angle in radians.
 * @returns The cosine of the angle.
 * @throws Error if the value is not a finite number.
 */
export function cos(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Input must be a finite number');
  }
  return Math.cos(value);
}

/**
 * Calculates the tangent of an angle in radians.
 * @param value - The angle in radians.
 * @returns The tangent of the angle.
 * @throws Error if the value is not a finite number.
 * @throws Error if the value is at an odd multiple of PI/2 (undefined tangent).
 */
export function tan(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Input must be a finite number');
  }
  const remainder = value % Math.PI;
  if (Math.abs(remainder) === Math.PI / 2 || Math.abs(remainder) === -Math.PI / 2) {
    throw new Error('Tangent is undefined at odd multiples of PI/2');
  }
  return Math.tan(value);
}

/**
 * Calculates the arcsine (inverse sine) of a value.
 * @param value - The value between -1 and 1.
 * @returns The arcsine in radians, in the range [-PI/2, PI/2].
 * @throws Error if the value is not in the range [-1, 1].
 */
export function asin(value: number): number {
  if (value < -1 || value > 1) {
    throw new Error('Input must be in the range [-1, 1]');
  }
  return Math.asin(value);
}

/**
 * Calculates the arccosine (inverse cosine) of a value.
 * @param value - The value between -1 and 1.
 * @returns The arccosine in radians, in the range [0, PI].
 * @throws Error if the value is not in the range [-1, 1].
 */
export function acos(value: number): number {
  if (value < -1 || value > 1) {
    throw new Error('Input must be in the range [-1, 1]');
  }
  return Math.acos(value);
}

/**
 * Calculates the arctangent (inverse tangent) of a value.
 * @param value - The value.
 * @returns The arctangent in radians, in the range (-PI/2, PI/2).
 * @throws Error if the value is not a finite number.
 */
export function atan(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Input must be a finite number');
  }
  return Math.atan(value);
}

/**
 * Calculates the hyperbolic sine of a value.
 * @param value - The value in radians.
 * @returns The hyperbolic sine.
 * @throws Error if the value is not a finite number.
 */
export function sinh(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Input must be a finite number');
  }
  return Math.sinh(value);
}

/**
 * Calculates the hyperbolic cosine of a value.
 * @param value - The value in radians.
 * @returns The hyperbolic cosine.
 * @throws Error if the value is not a finite number.
 */
export function cosh(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Input must be a finite number');
  }
  return Math.cosh(value);
}

/**
 * Calculates the hyperbolic tangent of a value.
 * @param value - The value in radians.
 * @returns The hyperbolic tangent, in the range (-1, 1).
 * @throws Error if the value is not a finite number.
 */
export function tanh(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Input must be a finite number');
  }
  return Math.tanh(value);
}

/**
 * Calculates the natural logarithm (base e) of a value.
 * @param value - The value (must be greater than 0).
 * @returns The natural logarithm.
 * @throws Error if the value is not greater than 0.
 */
export function log(value: number): number {
  if (value <= 0) {
    throw new Error('Input must be greater than 0');
  }
  return Math.log(value);
}

/**
 * Calculates the base-10 logarithm of a value.
 * @param value - The value (must be greater than 0).
 * @returns The base-10 logarithm.
 * @throws Error if the value is not greater than 0.
 */
export function log10(value: number): number {
  if (value <= 0) {
    throw new Error('Input must be greater than 0');
  }
  return Math.log10(value);
}

/**
 * Calculates the base-2 logarithm of a value.
 * @param value - The value (must be greater than 0).
 * @returns The base-2 logarithm.
 * @throws Error if the value is not greater than 0.
 */
export function log2(value: number): number {
  if (value <= 0) {
    throw new Error('Input must be greater than 0');
  }
  return Math.log2(value);
}

/**
 * Calculates e raised to the power of a value.
 * @param value - The exponent.
 * @returns e raised to the power of the input.
 * @throws Error if the value is not a finite number.
 */
export function exp(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Input must be a finite number');
  }
  return Math.exp(value);
}

/**
 * Returns the absolute value of a number.
 * @param value - The number.
 * @returns The absolute value.
 */
export function abs(value: number): number {
  return Math.abs(value);
}

/**
 * Rounds a number down to the nearest integer.
 * @param value - The number.
 * @returns The floor value.
 */
export function floor(value: number): number {
  return Math.floor(value);
}

/**
 * Rounds a number up to the nearest integer.
 * @param value - The number.
 * @returns The ceiling value.
 */
export function ceil(value: number): number {
  return Math.ceil(value);
}

/**
 * Rounds a number to the nearest integer.
 * @param value - The number.
 * @returns The rounded value.
 */
export function round(value: number): number {
  return Math.round(value);
}

/**
 * Converts radians to degrees.
 * @param radians - The angle in radians.
 * @returns The angle in degrees.
 * @throws Error if the input is not a finite number.
 */
export function degrees(radians: number): number {
  if (!Number.isFinite(radians)) {
    throw new Error('Input must be a finite number');
  }
  return radians * (180 / Math.PI);
}

/**
 * Converts degrees to radians.
 * @param degrees - The angle in degrees.
 * @returns The angle in radians.
 * @throws Error if the input is not a finite number.
 */
export function radians(degrees: number): number {
  if (!Number.isFinite(degrees)) {
    throw new Error('Input must be a finite number');
  }
  return degrees * (Math.PI / 180);
}

/**
 * Calculates the greatest common divisor of two integers.
 * @param a - First integer.
 * @param b - Second integer.
 * @returns The greatest common divisor.
 * @throws Error if inputs are not integers.
 * @throws Error if inputs are not positive.
 */
export function gcd(a: number, b: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new Error('Inputs must be integers');
  }
  if (a <= 0 || b <= 0) {
    throw new Error('Inputs must be positive integers');
  }
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const temp = y;
    y = x % y;
    x = temp;
  }
  return x;
}

/**
 * Calculates the least common multiple of two integers.
 * @param a - First integer.
 * @param b - Second integer.
 * @returns The least common multiple.
 * @throws Error if inputs are not integers.
 * @throws Error if inputs are not positive.
 */
export function lcm(a: number, b: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new Error('Inputs must be integers');
  }
  if (a <= 0 || b <= 0) {
    throw new Error('Inputs must be positive integers');
  }
  return Math.abs((a * b) / gcd(a, b));
}
