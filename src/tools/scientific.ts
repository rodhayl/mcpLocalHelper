// Scientific calculator utilities
// Trigonometric functions (radians)
export function sin(x: number): number {
  return Math.sin(x);
}
export function cos(x: number): number {
  return Math.cos(x);
}
export function tan(x: number): number {
  return Math.tan(x);
}
export function asin(x: number): number {
  return Math.asin(x);
}
export function acos(x: number): number {
  return Math.acos(x);
}
export function atan(x: number): number {
  return Math.atan(x);
}
// Hyperbolic functions
export function sinh(x: number): number {
  return Math.sinh(x);
}
export function cosh(x: number): number {
  return Math.cosh(x);
}
export function tanh(x: number): number {
  return Math.tanh(x);
}
// Logarithmic and exponential
export function log(x: number, base?: number): number {
  if (base === undefined) return Math.log(x);
  return Math.log(x) / Math.log(base);
}
export function log10(x: number): number {
  return Math.log10(x);
}
export function log2(x: number): number {
  return Math.log2(x);
}
export function exp(x: number): number {
  return Math.exp(x);
}
// Utility functions
export function abs(x: number): number {
  return Math.abs(x);
}
export function floor(x: number): number {
  return Math.floor(x);
}
export function ceil(x: number): number {
  return Math.ceil(x);
}
export function round(x: number, decimals?: number): number {
  if (decimals === undefined) return Math.round(x);
  const factor = Math.pow(10, decimals);
  return Math.round(x * factor) / factor;
}
// Unit conversion
export function degrees(rad: number): number {
  return rad * (180 / Math.PI);
}
export function radians(deg: number): number {
  return deg * (Math.PI / 180);
}
// Integer math
export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}
export function lcm(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return Math.abs((a * b) / gcd(a, b));
}
// Export all functions
export default {
  sin,
  cos,
  tan,
  asin,
  acos,
  atan,
  sinh,
  cosh,
  tanh,
  log,
  log10,
  log2,
  exp,
  abs,
  floor,
  ceil,
  round,
  degrees,
  radians,
  gcd,
  lcm,
};
