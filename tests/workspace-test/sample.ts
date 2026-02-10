// Sample test file for MCP tools testing
export function calculateSum(a: number, b: number): number {
  return a + b;
}

export function greet(name: string): string {
  // TODO: Add proper greeting logic
  return `Hello, ${name}!`;
}

// FIXME: This function has a bug
export function divide(a: number, b: number): number {
  return a / b;  // Missing zero check
}

const API_KEY = 'sk' + '-test-secret-key';  // Security issue: hardcoded key

export class Calculator {
  private value: number = 0;

  add(n: number): void {
    this.value += n;
  }

  getValue(): number {
    return this.value;
  }
}
