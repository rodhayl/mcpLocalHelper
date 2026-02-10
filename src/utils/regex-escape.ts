/**
 * Escape regex metacharacters so a string can be used as a literal pattern.
 */
export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
