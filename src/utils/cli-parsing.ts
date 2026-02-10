/**
 * Shared CLI output parsing utilities
 *
 * Phase 2 cleanup: Consolidated duplicate implementations from:
 * - src/adapters/cli-tool.ts
 * - src/orchestration/direct-cli-executor.ts
 */

/**
 * Extract file paths from CLI output content
 * Looks for common patterns indicating files were modified, created, or written
 */
export function extractFilesFromContent(content: string): string[] {
  const files: string[] = [];
  const patterns = [
    /[Mm]odified:\s*([^\s\n]+)/g,
    /[Cc]reated:\s*([^\s\n]+)/g,
    /[Ww]rote:\s*([^\s\n]+)/g,
    /File:\s*([^\s\n]+)/g,
    /"file_path":\s*"([^"]+)"/g,
    /"path":\s*"([^"]+)"/g,
    /```\w*\s+([^\n]+\.[a-zA-Z0-9_]+)/g, // Code block with filename
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const file = match[1];
      if (file && !files.includes(file) && !file.includes('```')) {
        files.push(file);
      }
    }
  }

  return files;
}

/**
 * Extract tools used from CLI output content
 * Looks for keywords indicating tool usage (bash, grep, write, etc.)
 */
export function extractToolsFromContent(content: string): string[] {
  const tools = new Set<string>();
  const toolPatterns = [
    /\b(bash|shell|exec|run|execute)\b/gi,
    /\b(glob|find)\b/gi,
    /\b(grep|search)\b/gi,
    /\b(view|read|cat|show)\b/gi,
    /\b(write|create)\b/gi,
    /\b(edit|patch|modify)\b/gi,
    /\b(fetch|curl|wget)\b/gi,
  ];

  for (const pattern of toolPatterns) {
    const match = content.match(pattern);
    if (match) {
      match.forEach((m) => tools.add(m.toLowerCase()));
    }
  }

  return Array.from(tools);
}
