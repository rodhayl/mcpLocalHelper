/**
 * Path Normalization Utility
 *
 * Provides consistent forward-slash path normalization across all tools.
 * This is critical for cross-platform compatibility, especially on Windows
 * where native path operations return backslashes but LLMs expect forward slashes.
 *
 * QA_feedback_7.md Analysis Task:
 * - Global path normalization (forward slashes) throughout codebase
 * - Fixes intelligent search empty results due to path key mismatch
 */

/**
 * Normalize a path to use forward slashes consistently.
 * This ensures paths work correctly across all platforms and match LLM expectations.
 *
 * @param path - The path to normalize (can be absolute or relative)
 * @returns The path with all backslashes converted to forward slashes
 *
 * @example
 * toForwardSlashes('src\\tools\\file.ts') // => 'src/tools/file.ts'
 * toForwardSlashes('C:\\Users\\name\\file.ts') // => 'C:/Users/name/file.ts'
 * toForwardSlashes('already/forward/slashes') // => 'already/forward/slashes'
 */
export function toForwardSlashes(path: string): string {
  if (!path || typeof path !== 'string') {
    return path;
  }
  return path.replace(/\\/g, '/');
}

/**
 * Normalize a path for use as a Map key or comparison.
 * Converts to forward slashes and lowercases for case-insensitive matching.
 *
 * @param path - The path to normalize for key usage
 * @returns Normalized path suitable for Map keys and comparisons
 *
 * @example
 * normalizePathKey('src\\Tools\\File.ts') // => 'src/tools/file.ts'
 */
export function normalizePathKey(path: string): string {
  return toForwardSlashes(path).toLowerCase();
}

/**
 * Normalize a relative path for consistent storage and retrieval.
 * Removes leading ./ and normalizes slashes.
 *
 * @param path - The relative path to normalize
 * @returns Normalized relative path
 *
 * @example
 * normalizeRelativePath('./src/file.ts') // => 'src/file.ts'
 * normalizeRelativePath('.\\src\\file.ts') // => 'src/file.ts'
 */
export function normalizeRelativePath(path: string): string {
  if (!path || typeof path !== 'string') {
    return path;
  }
  let normalized = toForwardSlashes(path);
  // Remove leading ./
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/**
 * Compare two paths for equality, ignoring slash direction and case (Windows).
 *
 * @param path1 - First path to compare
 * @param path2 - Second path to compare
 * @returns True if paths are equivalent
 *
 * @example
 * pathsEqual('src\\file.ts', 'src/file.ts') // => true
 * pathsEqual('SRC/File.ts', 'src/file.ts') // => true (Windows-safe)
 */
export function pathsEqual(path1: string, path2: string): boolean {
  if (!path1 || !path2) {
    return path1 === path2;
  }
  return normalizePathKey(path1) === normalizePathKey(path2);
}
