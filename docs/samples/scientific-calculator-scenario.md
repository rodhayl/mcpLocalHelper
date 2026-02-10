# Scientific Calculator Extension Scenario

**Date:** January 14, 2026
**Objective:** Test full MCP orchestration where LM Studio (local LLM) uses OpenCode CLI to extend the calculator to a scientific calculator

---

## Scenario Overview

This scenario demonstrates the complete hierarchical orchestration model:

1. User requests scientific calculator extension
2. Local LLM (LM Studio) analyzes request and decides to use OpenCode CLI
3. OpenCode CLI generates new mathematical functions
4. LLM validates the output and confirms completion

---

## Project Structure

```
tests/test-samples/calculator/
├── math.ts              # Original (basic operations)
├── math.test.ts         # Unit tests
├── package.json
└── scientific.ts        # NEW: Scientific functions (to be generated)
```

---

## Scientific Calculator Functions to Add

### Trigonometric Functions

- sin(x) - Sine
- cos(x) - Cosine
- tan(x) - Tangent
- asin(x) - Arcsine
- acos(x) - Arccosine
- atan(x) - Arctangent

### Hyperbolic Functions

- sinh(x) - Hyperbolic sine
- cosh(x) - Hyperbolic cosine
- tanh(x) - Hyperbolic tangent

### Logarithmic & Exponential

- log(x) - Natural logarithm
- log10(x) - Base-10 logarithm
- log2(x) - Base-2 logarithm
- exp(x) - e^x

### Additional Functions

- abs(x) - Absolute value
- floor(x) - Round down
- ceil(x) - Round up
- round(x) - Round to nearest
- degrees(x) - Convert radians to degrees
- radians(x) - Convert degrees to radians
- gcd(a, b) - Greatest common divisor
- lcm(a, b) - Least common multiple

---

## Task Prompt for OpenCode

```markdown
Extend the calculator in tests/test-samples/calculator to be a scientific calculator.

Current functions (math.ts):

- add, subtract, multiply, divide, power, sqrt, factorial

Add scientific functions (scientific.ts):

- Trigonometric: sin, cos, tan, asin, acos, atan
- Hyperbolic: sinh, cosh, tanh
- Log/Exp: log, log10, log2, exp
- Utility: abs, floor, ceil, round, degrees, radians, gcd, lcm

Requirements:

1. Create scientific.ts with all functions
2. Use Math.\* constants (Math.PI, Math.E, etc.)
3. Handle edge cases (negative inputs for log/sqrt, etc.)
4. Add JSDoc comments for all functions
5. Export all functions

Output JSON format:
{
"success": true/false,
"content": "Summary of changes",
"files_modified": ["scientific.ts"],
"tools_used": ["bash", "write"]
}
```

---

## Expected Orchestration Flow

### Step 1: User Request

```
User: "Extend the calculator to support scientific operations"
```

### Step 2: LLM Orchestrator Decision

```
LM Studio analyzes:
- Request requires adding new mathematical functions
- Best approach: Use OpenCode CLI for code generation
- Build task prompt for OpenCode
```

### Step 3: OpenCode Execution

```
OpenCode executes task:
- Reads existing math.ts
- Creates scientific.ts with 20+ new functions
- Handles edge cases
- Returns JSON result
```

### Step 4: Validation

```
LM Studio validates:
- File created successfully
- Functions exported correctly
- Edge cases handled
- Score: 9/10
```

---

## Test Commands

### 1. Verify OpenCode is Available

```bash
curl http://localhost:3000/api/backends
# Should show: opencode-cli available: true
```

### 2. Run Agent Task (Full Orchestration)

```bash
curl -X POST http://localhost:3000/api/tools/agent_task/execute \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Extend the calculator in tests/test-samples/calculator to be a scientific calculator. Add trigonometric (sin, cos, tan, asin, acos, atan), hyperbolic (sinh, cosh, tanh), logarithmic (log, log10, log2, exp), and utility (abs, floor, ceil, round, degrees, radians, gcd, lcm) functions. Create scientific.ts with all functions and update exports. Use OpenCode CLI for code generation.",
    "maxSteps": 10
  }'
```

### 3. Verify Generated File

```bash
cat tests/test-samples/calculator/scientific.ts
```

### 4. Run Tests

```bash
cd tests/test-samples/calculator && npm test
```

---

## Success Criteria

| Criterion                        | Status |
| -------------------------------- | ------ |
| OpenCode backend available       | ⏳     |
| Agent task starts                | ⏳     |
| OpenCode generates scientific.ts | ⏳     |
| File contains all functions      | ⏳     |
| Tests pass                       | ⏳     |

---

## Post-Execution Verification

### File Content Check

```typescript
// scientific.ts should export:
export function sin(x: number): number { ... }
export function cos(x: number): number { ... }
export function tan(x: number): number { ... }
export function log(x: number): number { ... }
export function gcd(a: number, b: number): number { ... }
// ... etc
```

### Test Execution

```bash
$ npm test
# Should pass with new scientific function tests
```

---

## Notes

- This scenario tests the full hierarchical model
- Local LLM orchestrates OpenCode CLI tool
- File modifications happen in workspace
- Validation ensures quality
