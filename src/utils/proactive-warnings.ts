/**
 * Proactive Warning System - Plan 3: Proactive Passive Warnings
 *
 * Provides proactive security and quality warnings that can be triggered
 * on file open or other events, with caching to avoid redundant scans.
 */

import { createHash } from 'crypto';
import type { ProactiveWarning, WarningSeverity, ProactiveWarningsConfig } from '../types/index.js';

/**
 * Warning cache entry with content hash for invalidation
 */
interface CacheEntry {
  warnings: ProactiveWarning[];
  contentHash: string;
  timestamp: number;
}

/**
 * Quick secret patterns for proactive scanning
 * More aggressive than full scan - designed for speed
 */
const QUICK_SECRET_PATTERNS = [
  {
    type: 'api_key',
    pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"][a-zA-Z0-9_-]{20,}['"]/gi,
    severity: 'warning' as WarningSeverity,
  },
  {
    type: 'openai_key',
    pattern: /sk-(?:proj-)?[a-zA-Z0-9]{32,}/g,
    severity: 'critical' as WarningSeverity,
  },
  {
    type: 'stripe_key',
    pattern: /sk_(?:live|test)_[A-Za-z0-9]{24,}/g,
    severity: 'critical' as WarningSeverity,
  },
  {
    type: 'password',
    pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"][^'"]{8,}['"]/gi,
    severity: 'critical' as WarningSeverity,
  },
  {
    type: 'private_key',
    pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE KEY-----/g,
    severity: 'critical' as WarningSeverity,
  },
  {
    type: 'aws_key',
    pattern: /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g,
    severity: 'critical' as WarningSeverity,
  },
  {
    type: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
    severity: 'warning' as WarningSeverity,
  },
  {
    type: 'github_token',
    pattern: /ghp_[A-Za-z0-9]{36}/g,
    severity: 'critical' as WarningSeverity,
  },
  {
    type: 'connection_string',
    pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+/gi,
    severity: 'warning' as WarningSeverity,
  },
];

/**
 * Quick vulnerability patterns
 */
const QUICK_VULN_PATTERNS = [
  {
    type: 'eval',
    pattern: /\beval\s*\(/g,
    severity: 'warning' as WarningSeverity,
    message: 'Potential code injection via eval()',
  },
  {
    type: 'innerHTML',
    pattern: /\.innerHTML\s*=/g,
    severity: 'warning' as WarningSeverity,
    message: 'Potential XSS via innerHTML assignment',
  },
  {
    type: 'sql_injection',
    pattern: /`.*\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE)/gi,
    severity: 'warning' as WarningSeverity,
    message: 'Potential SQL injection',
  },
];

/**
 * Proactive Warning Manager
 * Caches warnings per file and provides quick scanning capabilities
 */
export class ProactiveWarningManager {
  private cache: Map<string, CacheEntry> = new Map();
  private config: ProactiveWarningsConfig;
  private idCounter = 0;

  constructor(config?: Partial<ProactiveWarningsConfig>) {
    this.config = {
      enabled: config?.enabled ?? false,
      severityThreshold: config?.severityThreshold ?? 'warning',
      scanOnFileOpen: config?.scanOnFileOpen ?? true,
      cacheWarnings: config?.cacheWarnings ?? true,
      cacheTtlMs: config?.cacheTtlMs ?? 300000, // 5 minutes
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ProactiveWarningsConfig>): void {
    Object.assign(this.config, config);
  }

  /**
   * Check if proactive warnings are enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Generate a unique warning ID
   */
  private generateId(): string {
    return `warn_${Date.now()}_${++this.idCounter}`;
  }

  /**
   * Generate content hash for cache invalidation
   */
  private hashContent(content: string): string {
    return createHash('md5').update(content).digest('hex');
  }

  /**
   * Check if cache entry is valid
   */
  private isCacheValid(entry: CacheEntry, contentHash: string): boolean {
    if (!this.config.cacheWarnings) return false;
    if (entry.contentHash !== contentHash) return false;
    if (Date.now() - entry.timestamp > this.config.cacheTtlMs) return false;
    return true;
  }

  /**
   * Get cached warnings for a file if valid
   * Returns undefined if no valid cache exists
   */
  getCachedWarnings(filePath: string): ProactiveWarning[] | undefined {
    const entry = this.cache.get(filePath);
    if (!entry) return undefined;

    // Just check TTL, not content hash (we don't have content here)
    if (Date.now() - entry.timestamp > this.config.cacheTtlMs) {
      this.cache.delete(filePath);
      return undefined;
    }

    return entry.warnings;
  }

  /**
   * Scan content for proactive warnings
   * Quick scan optimized for speed over thoroughness
   * @param content The content to scan
   * @param filePath The file path (for cache keying)
   */
  scanContent(content: string, filePath: string): ProactiveWarning[] {
    if (!this.config.enabled) return [];

    const contentHash = this.hashContent(content);

    // Check cache first
    const entry = this.cache.get(filePath);
    if (entry && this.isCacheValid(entry, contentHash)) {
      return entry.warnings;
    }

    const warnings: ProactiveWarning[] = [];
    const lines = content.split('\n');
    const now = Date.now();

    // Secret scanning
    for (const { type, pattern, severity } of QUICK_SECRET_PATTERNS) {
      // Skip if below threshold
      if (!this.meetsThreshold(severity)) continue;

      pattern.lastIndex = 0; // Reset regex state
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const lineIndex = content.substring(0, match.index).split('\n').length - 1;
        const line = lines[lineIndex];

        // Skip false positives
        if (this.isFalsePositive(line, type)) continue;

        warnings.push({
          id: this.generateId(),
          severity,
          type: 'secret',
          file: filePath,
          line: lineIndex + 1,
          message: `Potential ${type.replace(/_/g, ' ')} detected`,
          suggestion: `Consider using environment variables or a secrets manager`,
          timestamp: now,
        });
      }
    }

    // Vulnerability scanning
    for (const { type: vulnType, pattern, severity, message } of QUICK_VULN_PATTERNS) {
      if (!this.meetsThreshold(severity)) continue;

      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const lineIndex = content.substring(0, match.index).split('\n').length - 1;

        warnings.push({
          id: this.generateId(),
          severity,
          type: vulnType,
          file: filePath,
          line: lineIndex + 1,
          message,
          suggestion: `Review this code for potential security issues`,
          timestamp: now,
        });
      }
    }

    // Cache the results
    if (this.config.cacheWarnings) {
      this.cache.set(filePath, {
        warnings,
        contentHash: this.hashContent(content),
        timestamp: now,
      });
    }

    return warnings;
  }

  /**
   * Check if severity meets the configured threshold
   */
  private meetsThreshold(severity: WarningSeverity): boolean {
    const order: Record<WarningSeverity, number> = {
      critical: 0,
      warning: 1,
      info: 2,
    };
    return order[severity] <= order[this.config.severityThreshold];
  }

  /**
   * Check if a line is likely a false positive
   * @param line The line content to check
   * @param _type The type of warning (reserved for future type-specific checks)
   */
  private isFalsePositive(line: string, _type: string): boolean {
    const lowerLine = line.toLowerCase();

    // Common false positive patterns
    const falsePositivePatterns = [
      /example/i,
      /placeholder/i,
      /your[-_]?api[-_]?key/i,
      /xxx+/i,
      /test[-_]?key/i,
      /fake[-_]?/i,
      /dummy[-_]?/i,
      /sample[-_]?/i,
      /\/\/.*comment/i,
      /\*.*comment/i,
    ];

    return falsePositivePatterns.some((p) => p.test(lowerLine));
  }

  /**
   * Clear cache for a specific file or all files
   */
  clearCache(filePath?: string): void {
    if (filePath) {
      this.cache.delete(filePath);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Get all cached warnings
   */
  getAllCachedWarnings(): ProactiveWarning[] {
    const all: ProactiveWarning[] = [];
    for (const entry of this.cache.values()) {
      all.push(...entry.warnings);
    }
    return all;
  }

  /**
   * Filter warnings by severity
   */
  filterBySeverity(warnings: ProactiveWarning[], minSeverity: WarningSeverity): ProactiveWarning[] {
    const order: Record<WarningSeverity, number> = {
      critical: 0,
      warning: 1,
      info: 2,
    };
    const minOrder = order[minSeverity];
    return warnings.filter((w) => order[w.severity] <= minOrder);
  }

  /**
   * Format warnings for display
   */
  formatWarnings(warnings: ProactiveWarning[]): string {
    if (warnings.length === 0) return 'No warnings';

    return warnings
      .map((w) => {
        const loc = w.line ? `:${w.line}` : '';
        const sev = w.severity.toUpperCase();
        return `[${sev}] ${w.file}${loc}: ${w.message}${w.suggestion ? ` (${w.suggestion})` : ''}`;
      })
      .join('\n');
  }
}

// Singleton instance
let instance: ProactiveWarningManager | null = null;

export function getProactiveWarningManager(
  config?: Partial<ProactiveWarningsConfig>
): ProactiveWarningManager {
  if (!instance) {
    instance = new ProactiveWarningManager(config);
  } else if (config) {
    instance.updateConfig(config);
  }
  return instance;
}

export function resetProactiveWarningManager(): void {
  instance = null;
}
