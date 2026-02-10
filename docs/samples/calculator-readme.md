# Test Sample: Calculator Project

This directory contains a simple math library for testing OpenCode CLI integration.

## Files

- `math.ts` - The math library with functions: add, subtract, multiply, divide, power, sqrt, factorial
- `package.json` - Minimal package.json with vitest for testing

## Expected Output

When OpenCode generates tests for `math.ts`, it should:

1. Create `math.test.ts` or similar test file
2. Use vitest as the test framework
3. Test all functions:
   - `add(2, 3)` should return `5`
   - `subtract(5, 3)` should return `2`
   - `multiply(4, 5)` should return `20`
   - `divide(10, 2)` should return `5`
   - `divide(10, 0)` should throw an error
   - `power(2, 3)` should return `8`
   - `sqrt(9)` should return `3`
   - `sqrt(-1)` should throw an error
   - `factorial(5)` should return `120`
   - `factorial(-1)` should throw an error

## Testing

After configuring OpenCode in the MCP server, you can test by:

1. Starting the server: `npm start`
2. Opening http://localhost:3000
3. Adding an OpenCode CLI backend
4. Sending a task like: "Write comprehensive unit tests for the math.ts file"

The OpenCode adapter should:

- Execute the task via OpenCode CLI
- Parse the JSON output
- Report files modified
- Provide validation score
