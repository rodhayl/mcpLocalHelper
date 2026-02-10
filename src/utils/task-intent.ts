export function inferReadOnlyFromTaskText(task: string): boolean {
  const t = String(task || '').toLowerCase();

  // F3-006: Very short prompts without write verbs should be read-only by default
  // This prevents trivial prompts like "Say ok" from creating files
  const words = t.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= 5) {
    // Check for simple response requests that should not write files
    const simpleResponsePatterns = [
      /^say\b/i,
      /^echo\b/i,
      /^reply\b/i,
      /^respond\b/i,
      /^print\b/i,
      /^output\b/i,
      /^return\b/i,
      /^tell\b/i,
      /^greet\b/i,
      /^hello\b/i,
      /^hi\b/i,
      /^ok\b/i,
      /^okay\b/i,
      /^yes\b/i,
      /^no\b/i,
    ];
    if (simpleResponsePatterns.some((p) => p.test(t))) {
      return true;
    }
  }

  // Explicit, user-provided constraints should win.
  const explicitReadOnlyPhrases = [
    'do not modify',
    "don't modify",
    'dont modify',
    'without modifying',
    'read-only',
    'read only',
    'readonly',
    'no changes',
    'do not change',
    "don't change",
    'dont change',
    'no edits',
    'do not edit',
    "don't edit",
    'dont edit',
    'do not write',
    "don't write",
    'dont write',
    'no writing',
  ];
  if (explicitReadOnlyPhrases.some((p) => t.includes(p))) return true;

  // If the task clearly asks to modify the workspace, do NOT infer readOnly.
  const writeIntent = [
    /\bfix(?:es|ed|ing)?\b/i,
    /\bedit(?:s|ed|ing)?\b/i,
    /\brefactor(?:s|ed|ing)?\b/i,
    /\bimplement(?:s|ed|ing)?\b/i,
    /\badd(?:s|ed|ing)?\b/i,
    /\bremove(?:s|d|ing)?\b/i,
    /\bdelete(?:s|d|ing)?\b/i,
    /\bcreate(?:s|d|ing)?\b/i,
    /\bwrite(?:s|ing)?\b/i,
    /\bupdate(?:s|d|ing)?\b/i,
    /\bupgrade(?:s|d|ing)?\b/i,
    /\bapply(?:s|ed|ing)?\b/i,
    /\bpatch(?:es|ed|ing)?\b/i,
    /\brename(?:s|d|ing)?\b/i,
    /\bmove(?:s|d|ing)?\b/i,
    /\bformat(?:s|ted|ting)?\b/i,
    /\blint(?:s|ed|ing)?\b/i,
    /\bimprove(?:s|d|ing)?\b/i,
    /\breplace(?:s|d|ing)?\b/i,
    /\bmake changes?\b/i,
    /\bapply changes?\b/i,
  ];
  if (writeIntent.some((re) => re.test(t))) return false;

  // Otherwise, treat common analysis/reporting requests as read-only by default.
  const readOnlyIntent = [
    /\banaly(?:se|ze)(?:s|d|ing)?\b/i,
    /\baudit(?:s|ed|ing)?\b/i,
    /\breview(?:s|ed|ing)?\b/i,
    /\binspect(?:s|ed|ing)?\b/i,
    /\bsummar(?:ize|ise|y)(?:s|d|ing)?\b/i,
    /\bexplain(?:s|ed|ing)?\b/i,
    /\bdescribe(?:s|d|ing)?\b/i,
    /\blist(?:s|ed|ing)?\b/i,
    /\bcount(?:s|ed|ing)?\b/i,
    /\bsearch(?:es|ed|ing)?\b/i,
    /\bfind(?:s|ing)?\b/i,
    /\blocate(?:s|d|ing)?\b/i,
    /\benumerate(?:s|d|ing)?\b/i,
    /\bidentify(?:s|d|ing)?\b/i,
    /\bcompare(?:s|d|ing)?\b/i,
    /\bvalidate(?:s|d|ing)?\b/i,
    /\bverify(?:s|ied|ing)?\b/i,
    /\bcheck(?:s|ed|ing)?\b/i,
    /\bscan(?:s|ned|ning)?\b/i,
    /\breport(?:s|ed|ing)?\b/i,
  ];
  if (readOnlyIntent.some((re) => re.test(t))) return true;

  return false;
}
