export interface GlobRegexOptions {
  /**
   * When true, `*` can match path separators.
   * When false, `*` maps to `[^/]*`.
   */
  starMatchesSlash?: boolean;
  /**
   * When true, globstar tokens (`**` and `**` followed by `/`) are handled.
   */
  supportGlobstar?: boolean;
}

export interface GlobToRegExpOptions extends GlobRegexOptions {
  /**
   * Regex flags for the constructed expression.
   */
  flags?: string;
  /**
   * Anchor regex with ^...$ (default: true).
   */
  anchored?: boolean;
}

/**
 * Convert a glob pattern into a regex source string.
 */
export function globToRegexSource(glob: string, options: GlobRegexOptions = {}): string {
  const starMatchesSlash = options.starMatchesSlash ?? false;
  const supportGlobstar = options.supportGlobstar ?? true;

  let regex = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  if (supportGlobstar) {
    // Use placeholders so later `*` replacement does not mutate inserted patterns.
    regex = regex.replace(/\*\*\//g, '__GLOBSTAR_DIR__');
    regex = regex.replace(/\*\*/g, '__GLOBSTAR__');
  }

  regex = regex.replace(/\*/g, starMatchesSlash ? '.*' : '[^/]*');
  regex = regex.replace(/\?/g, '.');

  if (supportGlobstar) {
    regex = regex.replace(/__GLOBSTAR_DIR__/g, '(?:.*/)?');
    regex = regex.replace(/__GLOBSTAR__/g, '.*');
  }

  return regex;
}

/**
 * Convert a glob pattern into a RegExp.
 */
export function globToRegExp(glob: string, options: GlobToRegExpOptions = {}): RegExp {
  const { flags = '', anchored = true, ...globOptions } = options;
  const source = globToRegexSource(glob, globOptions);
  return new RegExp(anchored ? `^${source}$` : source, flags);
}
