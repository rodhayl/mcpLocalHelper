export type RedactionMode = 'default' | 'strict';

export interface RedactionSummary {
  mode: RedactionMode;
  totalReplacements: number;
  byPattern: Record<string, number>;
}

interface RedactionRule {
  name: string;
  regex: RegExp;
  replacement: string;
  strictOnly?: boolean;
}

export class RedactionEngine {
  private readonly replacement = '[REDACTED]';
  private readonly mode: RedactionMode;
  private readonly rules: RedactionRule[];

  constructor(options?: { mode?: RedactionMode }) {
    this.mode = options?.mode ?? 'default';

    // NOTE: Prefer preserving structure where possible (keep keys/assignment, redact values).
    // This improves auditability while still preventing accidental secret exfiltration.
    const genericSecretMinLen = this.mode === 'strict' ? 16 : 24;

    this.rules = [
      {
        name: 'OpenAI/Anthropic Key',
        regex: /(?<![a-zA-Z0-9_])sk-[a-zA-Z0-9_-]{10,}/g,
        replacement: this.replacement,
      },
      {
        name: 'API_KEY Declaration',
        regex: /((?:const|let|var)\s+(?:API_?KEY|api_?key)\s*=\s*['"])([^'"]+)(['"])/gi,
        replacement: `$1${this.replacement}$3`,
      },
      {
        name: 'API Key Assignment',
        regex: /((?:api[_-]?key|apikey)\s*[:=]\s*["']?)([a-zA-Z0-9_-]{20,})(["']?)/gi,
        replacement: `$1${this.replacement}$3`,
      },
      {
        name: 'Bearer Token',
        regex: /(\bbearer\s+)([a-zA-Z0-9_-]{20,})/gi,
        replacement: `$1${this.replacement}`,
      },
      {
        name: 'JWT Token',
        regex: /eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
        replacement: this.replacement,
      },
      {
        name: 'AWS Access Key',
        regex: /AKIA[0-9A-Z]{16}/g,
        replacement: this.replacement,
      },
      {
        name: 'GitHub Token',
        regex: /ghp_[a-zA-Z0-9]{36}/g,
        replacement: this.replacement,
      },
      {
        name: 'Generic Secret Assignment',
        regex: new RegExp(
          `((?:password|secret|token|private[_-]?key)\\s*[:=]\\s*["']?)([a-zA-Z0-9_\\-]{${genericSecretMinLen},})(["']?)`,
          'gi'
        ),
        replacement: `$1${this.replacement}$3`,
      },
      {
        name: '.env Assignment',
        regex: /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*([^#\r\n]*)(\s*#.*)?$/gm,
        replacement: `$1=${this.replacement}$3`,
        // Default mode should avoid over-redacting non-secret env-style lines that may appear in docs/code.
        // Strict mode can redact all env assignments for maximum safety.
        strictOnly: true,
      },
      {
        name: 'URL Credentials',
        regex: /((?:https?|ftp):\/\/)([a-zA-Z0-9_-]+):([^@\s]+)@/gi,
        replacement: `$1$2:${this.replacement}@`,
      },
    ];
  }

  redactWithSummary(text: string): { text: string; summary: RedactionSummary } {
    let redacted = text;
    const byPattern: Record<string, number> = {};
    let totalReplacements = 0;

    for (const rule of this.rules) {
      if (rule.strictOnly && this.mode !== 'strict') continue;

      // matchAll requires global; all our rules use global/multiline flags as needed.
      const matches = Array.from(redacted.matchAll(rule.regex));
      if (matches.length === 0) continue;

      byPattern[rule.name] = (byPattern[rule.name] || 0) + matches.length;
      totalReplacements += matches.length;
      redacted = redacted.replace(rule.regex, rule.replacement);
    }

    return {
      text: redacted,
      summary: {
        mode: this.mode,
        totalReplacements,
        byPattern,
      },
    };
  }

  redact(text: string): string {
    return this.redactWithSummary(text).text;
  }

  redactObject(obj: unknown): unknown {
    if (typeof obj === 'string') {
      return this.redact(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactObject(item));
    }

    if (typeof obj === 'object' && obj !== null) {
      const redacted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        // Skip common sensitive keys entirely
        if (this.isSensitiveKey(key)) {
          redacted[key] = this.replacement;
        } else {
          redacted[key] = this.redactObject(value);
        }
      }
      return redacted;
    }

    return obj;
  }

  private isSensitiveKey(key: string): boolean {
    const sensitiveKeys = [
      'password',
      'secret',
      'token',
      'api_key',
      'apikey',
      'private_key',
      'access_key',
      'secret_key',
      'auth',
      'credential',
      'bearer',
    ];

    const lowerKey = key.toLowerCase();
    return sensitiveKeys.some((sensitive) => lowerKey.includes(sensitive));
  }

  truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
    const encoder = new TextEncoder();

    if (encoder.encode(text).length <= maxBytes) {
      return { text, truncated: false };
    }

    // Binary search for the right length
    let low = 0;
    let high = text.length;

    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      const chunk = text.slice(0, mid);

      if (encoder.encode(chunk).length <= maxBytes) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    const truncatedText = text.slice(0, low) + '\n...[truncated]';
    return { text: truncatedText, truncated: true };
  }

  applySotaFilters(text: string): string {
    // Additional filters for SOTA backend
    // Remove large code blocks
    const withoutLargeBlocks = text.replace(/```[\s\S]{1000,}```/g, '[LARGE CODE BLOCK REMOVED]');

    // Remove file paths that might be sensitive
    const withoutPaths = withoutLargeBlocks.replace(/[a-zA-Z]:\\[^\s]+/g, '[PATH]');

    // Apply standard redaction
    return this.redact(withoutPaths);
  }

  /**
   * Strip <think>...</think> blocks from LLM responses.
   * Many local LLMs (especially Qwen models) include "thinking" output
   * that should be hidden from end users.
   */
  stripThinkTags(text: string): string {
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');

    // Also strip common model control tokens that leak into output
    // These are special tokens used by various LLM architectures
    cleaned = this.stripModelControlTokens(cleaned);

    return cleaned.trim();
  }

  /**
   * Strip model control tokens that may leak into LLM output.
   * Different models use different special tokens:
   * - GPT/OAI: <|endoftext|>, <|im_end|>, <|im_start|>
   * - Llama/Mistral: </s>, <s>, [INST], [/INST]
   * - DeepSeek/Qwen: <|channel|>, <|assistant|>, <|user|>
   * - Various: <|eot_id|>, <|begin_of_text|>, etc.
   */
  stripModelControlTokens(text: string): string {
    // Match common control token patterns
    const patterns = [
      /<\|[a-z_]+\|>/gi, // <|channel|>, <|endoftext|>, <|im_end|>, etc.
      /<\|begin_of_text\|>/gi,
      /<\|end_of_text\|>/gi,
      /<\|eot_id\|>/gi,
      /\[INST\]/gi,
      /\[\/INST\]/gi,
      /<<SYS>>/gi,
      /<<\/SYS>>/gi,
      /<\|assistant\|>/gi,
      /<\|user\|>/gi,
      /<\|system\|>/gi,
      /\[end\]/gi, // Some models use [end] marker
      /<\|final\|>/gi,
    ];

    let cleaned = text;
    for (const pattern of patterns) {
      cleaned = cleaned.replace(pattern, '');
    }

    // Clean up any resulting multiple spaces or leading/trailing whitespace
    cleaned = cleaned.replace(/\s{2,}/g, ' ');

    return cleaned;
  }
}
