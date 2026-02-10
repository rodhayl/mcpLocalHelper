/**
 * Shared Language Map
 *
 * Single source of truth for file extension → language name mappings.
 * Used by file tools, edit tools, and LLM-enhanced tools.
 */

/**
 * Maps file extensions (without dot) to language names.
 * This is the canonical mapping used across the codebase.
 */
export const LANGUAGE_MAP: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  cs: 'csharp',
  cpp: 'cpp',
  c: 'c',
  h: 'c',
  hpp: 'cpp',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  md: 'markdown',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  r: 'r',
  R: 'r',
  lua: 'lua',
  php: 'php',
  dart: 'dart',
  zig: 'zig',
  toml: 'toml',
};

/**
 * Maps dot-prefixed extensions to language names (for tools that use dots).
 * Derived from LANGUAGE_MAP.
 */
export const LANGUAGE_MAP_DOTTED: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LANGUAGE_MAP).map(([ext, lang]) => [`.${ext}`, lang])
);

/**
 * Look up a language from an extension (with or without leading dot).
 */
export function getLanguageFromExtension(ext: string): string | null {
  const normalized = ext.startsWith('.') ? ext.slice(1).toLowerCase() : ext.toLowerCase();
  return LANGUAGE_MAP[normalized] ?? null;
}
