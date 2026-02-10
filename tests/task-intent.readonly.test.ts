import { describe, it, expect } from 'vitest';
import { inferReadOnlyFromTaskText } from '../src/utils/task-intent.js';

describe('inferReadOnlyFromTaskText', () => {
  it('infers readOnly for common analysis intents', () => {
    expect(inferReadOnlyFromTaskText('Analyze the repo and list findings')).toBe(true);
    expect(inferReadOnlyFromTaskText('Search for TODO comments and report counts')).toBe(true);
    expect(inferReadOnlyFromTaskText('Summarize src/index.ts')).toBe(true);
  });

  it('does not infer readOnly for explicit write intents', () => {
    expect(inferReadOnlyFromTaskText('Fix failing tests in the project')).toBe(false);
    expect(inferReadOnlyFromTaskText('Refactor the agent runner to reduce latency')).toBe(false);
    expect(inferReadOnlyFromTaskText('Create a new file called notes.txt')).toBe(false);
  });

  it('treats explicit read-only phrases as readOnly', () => {
    expect(inferReadOnlyFromTaskText('Do not modify any files; just audit the code')).toBe(true);
    expect(inferReadOnlyFromTaskText("Don't change anything; only review")).toBe(true);
    expect(inferReadOnlyFromTaskText('Read-only analysis of package.json')).toBe(true);
  });
});

