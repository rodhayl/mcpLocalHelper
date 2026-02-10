/**
 * Semantic Memory
 *
 * Vector-based semantic search for code files using embeddings.
 * Uses LM Studio's embedding API with configurable model.
 *
 * - Indexes source files with embeddings for semantic search
 * - Cosine similarity matching for relevant code retrieval
 * - File-based persistence for embedding cache
 * - Incremental updates on file changes
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { dirname, join, extname } from 'path';
import { homedir } from 'os';
import {
  getCircuitBreakerRegistry,
  CircuitOpenError,
  CircuitBreaker,
} from '../utils/circuit-breaker.js';

export interface SemanticMemoryConfig {
  /** LM Studio base URL (default: http://127.0.0.1:1234) */
  lmStudioBaseUrl: string;
  /** Embedding model to use (default: embeddinggemma-300m.Q4_0) */
  embeddingModel: string;
  /** Path to embedding cache file */
  cachePath: string;
  /** Maximum chunk size in characters */
  maxChunkSize: number;
  /** Overlap between chunks */
  chunkOverlap: number;
  /** Top K results to return */
  defaultTopK: number;
  /** Enable/disable semantic memory (default: true) */
  enabled: boolean;
  /** File extensions to index */
  indexExtensions: string[];
  /** Maximum files to index */
  maxFiles: number;
}

export interface CodeChunk {
  /** Unique ID for this chunk */
  id: string;
  /** File path relative to workspace */
  filePath: string;
  /** Line range [start, end] */
  lineRange: [number, number];
  /** Chunk content */
  content: string;
  /** Embedding vector */
  embedding: number[];
  /** File hash for invalidation */
  fileHash: string;
  /** When this was indexed */
  indexedAt: string;
}

export interface SemanticSearchResult {
  /** Matched chunk */
  chunk: Omit<CodeChunk, 'embedding'>;
  /** Similarity score (0-1) */
  score: number;
}

interface PersistedIndex {
  version: 2;
  savedAt: string;
  modelId: string;
  chunks: CodeChunk[];
}

const DEFAULT_CONFIG: SemanticMemoryConfig = {
  lmStudioBaseUrl: 'http://127.0.0.1:1234',
  embeddingModel: 'godiscus-sapientia/embeddinggemma-300m.Q4_0',
  cachePath: join(homedir(), '.mcp-local-llm', 'semantic-index.json'),
  maxChunkSize: 1500,
  chunkOverlap: 200,
  defaultTopK: 5,
  enabled: true,
  indexExtensions: ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.md'],
  maxFiles: 500,
};

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

export class SemanticMemory {
  private config: SemanticMemoryConfig;
  private chunks: Map<string, CodeChunk> = new Map();
  private fileHashes: Map<string, string> = new Map();
  private dirty = false;
  private indexedWorkspace: string | null = null;
  private circuitBreaker: CircuitBreaker;

  /** Timeout for embedding requests (ms) */
  private static readonly EMBEDDING_TIMEOUT_MS = 5000;

  constructor(config?: Partial<SemanticMemoryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.circuitBreaker = getCircuitBreakerRegistry().get('semantic-memory-embedding', {
      failureThreshold: 3,
      resetTimeoutMs: 30000,
    });
    this.load();
  }

  /**
   * Configure the embedding backend
   */
  configure(options: { lmStudioBaseUrl?: string; embeddingModel?: string }): void {
    if (options.lmStudioBaseUrl) {
      this.config.lmStudioBaseUrl = options.lmStudioBaseUrl;
    }
    if (options.embeddingModel) {
      // If model changed, invalidate all cached embeddings
      if (this.config.embeddingModel !== options.embeddingModel) {
        this.chunks.clear();
        this.fileHashes.clear();
        this.dirty = true;
      }
      this.config.embeddingModel = options.embeddingModel;
    }
  }

  /**
   * Hash file content for change detection
   */
  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  /**
   * Split file content into chunks
   */
  private chunkContent(
    content: string,
    _filePath: string
  ): Array<{ content: string; lineRange: [number, number] }> {
    const lines = content.split('\n');
    const chunks: Array<{ content: string; lineRange: [number, number] }> = [];

    let currentChunk = '';
    let startLine = 1;
    let currentLine = 1;

    for (const line of lines) {
      if (currentChunk.length + line.length + 1 > this.config.maxChunkSize) {
        if (currentChunk.trim()) {
          chunks.push({
            content: currentChunk.trim(),
            lineRange: [startLine, currentLine - 1],
          });
        }

        // Overlap: keep some lines from the end
        const overlapLines = Math.floor(this.config.chunkOverlap / 50); // ~50 chars per line
        const linesInChunk = currentChunk.split('\n');
        if (linesInChunk.length > overlapLines) {
          currentChunk = linesInChunk.slice(-overlapLines).join('\n') + '\n';
          startLine = currentLine - overlapLines;
        } else {
          currentChunk = '';
          startLine = currentLine;
        }
      }

      currentChunk += line + '\n';
      currentLine++;
    }

    // Last chunk
    if (currentChunk.trim()) {
      chunks.push({
        content: currentChunk.trim(),
        lineRange: [startLine, currentLine - 1],
      });
    }

    return chunks;
  }

  /**
   * Call LM Studio embedding API with circuit breaker and timeout protection
   */
  private async getEmbedding(text: string): Promise<number[]> {
    return this.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SemanticMemory.EMBEDDING_TIMEOUT_MS);

      try {
        const response = await fetch(`${this.config.lmStudioBaseUrl}/v1/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.embeddingModel,
            input: text,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Embedding API error: ${response.status} - ${errorText}`);
        }

        const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };

        // LM Studio/OpenAI format: { data: [{ embedding: number[] }] }
        if (data.data && data.data[0] && Array.isArray(data.data[0].embedding)) {
          return data.data[0].embedding;
        }

        throw new Error('Unexpected embedding response format');
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            throw new Error(
              `Embedding request timed out after ${SemanticMemory.EMBEDDING_TIMEOUT_MS}ms`
            );
          }
          if (error.message.includes('ECONNREFUSED')) {
            throw new Error(
              `LM Studio not reachable at ${this.config.lmStudioBaseUrl}. Please start LM Studio and load the embedding model.`
            );
          }
        }
        throw error;
      }
    });
  }

  /**
   * Check if the circuit breaker is currently open (failing fast)
   */
  isCircuitOpen(): boolean {
    return this.circuitBreaker.getState() === 'open';
  }

  /**
   * Get circuit breaker stats for diagnostics
   */
  getCircuitBreakerStats(): { state: string; failures: number; totalRequests: number } {
    const stats = this.circuitBreaker.getStats();
    return {
      state: stats.state,
      failures: stats.failures,
      totalRequests: stats.totalRequests,
    };
  }

  /**
   * Index a workspace directory
   */
  async index(
    contextRoot: string,
    options?: { force?: boolean }
  ): Promise<{
    indexed: number;
    skipped: number;
    errors: string[];
  }> {
    if (!this.config.enabled) {
      return { indexed: 0, skipped: 0, errors: ['Semantic memory disabled'] };
    }

    const errors: string[] = [];
    let indexed = 0;
    let skipped = 0;

    // Collect files to index
    const files = this.collectFiles(contextRoot);

    if (process.env.DEBUG_SEMANTIC_MEMORY === '1') {
      process.stderr.write(`[semantic] Found ${files.length} files to index\n`);
    }

    for (const filePath of files.slice(0, this.config.maxFiles)) {
      try {
        const fullPath = join(contextRoot, filePath);
        const content = readFileSync(fullPath, 'utf-8');
        const hash = this.hashContent(content);

        // Check if file is already indexed with same hash
        if (!options?.force && this.fileHashes.get(filePath) === hash) {
          skipped++;
          continue;
        }

        // Remove old chunks for this file
        this.invalidateFile(filePath);

        // Chunk and embed
        const chunks = this.chunkContent(content, filePath);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const id = `${this.hashContent(filePath)}-${i}`;

          try {
            const embedding = await this.getEmbedding(chunk.content);

            const codeChunk: CodeChunk = {
              id,
              filePath,
              lineRange: chunk.lineRange,
              content: chunk.content,
              embedding,
              fileHash: hash,
              indexedAt: new Date().toISOString(),
            };

            this.chunks.set(id, codeChunk);
            this.dirty = true;
          } catch (embError) {
            errors.push(`Failed to embed ${filePath}:${chunk.lineRange[0]}: ${embError}`);
          }
        }

        this.fileHashes.set(filePath, hash);
        indexed++;

        if (process.env.DEBUG_SEMANTIC_MEMORY === '1') {
          process.stderr.write(`[semantic] Indexed ${filePath} (${chunks.length} chunks)\n`);
        }
      } catch (fileError) {
        errors.push(`Failed to process ${filePath}: ${fileError}`);
      }
    }

    this.indexedWorkspace = contextRoot;
    this.save();

    return { indexed, skipped, errors };
  }

  /**
   * Collect files to index from a directory
   */
  private collectFiles(dir: string, base = ''): string[] {
    const files: string[] = [];
    const skipDirs = new Set([
      'node_modules',
      'dist',
      'build',
      '.git',
      '__pycache__',
      '.venv',
      'venv',
    ]);

    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const relativePath = base ? join(base, entry.name) : entry.name;

        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name) && !entry.name.startsWith('.')) {
            files.push(...this.collectFiles(join(dir, entry.name), relativePath));
          }
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (this.config.indexExtensions.includes(ext)) {
            // Check file size (skip very large files)
            try {
              const stat = statSync(join(dir, entry.name));
              if (stat.size < 100000) {
                // 100KB max
                files.push(relativePath);
              }
            } catch {
              // Skip files we can't stat
            }
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }

    return files;
  }

  /**
   * Invalidate cached chunks for a file
   */
  invalidateFile(filePath: string): void {
    const toDelete: string[] = [];

    for (const [id, chunk] of this.chunks.entries()) {
      if (chunk.filePath === filePath) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.chunks.delete(id);
    }

    this.fileHashes.delete(filePath);
    this.dirty = true;
  }

  /**
   * Semantic search for relevant code
   */
  async search(query: string, topK?: number): Promise<SemanticSearchResult[]> {
    if (!this.config.enabled || this.chunks.size === 0) {
      return [];
    }

    const k = topK ?? this.config.defaultTopK;

    try {
      const queryEmbedding = await this.getEmbedding(query);

      // Calculate similarities
      const results: Array<{ chunk: CodeChunk; score: number }> = [];

      for (const chunk of this.chunks.values()) {
        const score = cosineSimilarity(queryEmbedding, chunk.embedding);
        results.push({ chunk, score });
      }

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);

      // Return top K without embedding vectors
      return results.slice(0, k).map((r) => ({
        chunk: {
          id: r.chunk.id,
          filePath: r.chunk.filePath,
          lineRange: r.chunk.lineRange,
          content: r.chunk.content,
          fileHash: r.chunk.fileHash,
          indexedAt: r.chunk.indexedAt,
        },
        score: r.score,
      }));
    } catch (error) {
      // Graceful degradation: log and return empty results instead of throwing
      // This allows the agent to continue without semantic memory
      if (error instanceof CircuitOpenError) {
        if (process.env.DEBUG_SEMANTIC_MEMORY === '1') {
          process.stderr.write(`[semantic] Search skipped: circuit breaker open\n`);
        }
      } else if (process.env.DEBUG_SEMANTIC_MEMORY === '1') {
        process.stderr.write(`[semantic] Search failed: ${error}\n`);
      }
      return [];
    }
  }

  /**
   * Load index from disk
   */
  private load(): void {
    try {
      if (!existsSync(this.config.cachePath)) return;

      const content = readFileSync(this.config.cachePath, 'utf-8');
      const data: PersistedIndex = JSON.parse(content);

      if (data.version !== 2) return;

      // Only use cache if same model
      if (data.modelId !== this.config.embeddingModel) {
        if (process.env.DEBUG_SEMANTIC_MEMORY === '1') {
          process.stderr.write(`[semantic] Model changed, invalidating cache\n`);
        }
        return;
      }

      for (const chunk of data.chunks) {
        this.chunks.set(chunk.id, chunk);
        this.fileHashes.set(chunk.filePath, chunk.fileHash);
      }

      if (process.env.DEBUG_SEMANTIC_MEMORY === '1') {
        process.stderr.write(`[semantic] Loaded ${this.chunks.size} chunks from cache\n`);
      }
    } catch (e) {
      if (process.env.DEBUG_SEMANTIC_MEMORY === '1') {
        process.stderr.write(`[semantic] Load error: ${e}\n`);
      }
    }
  }

  /**
   * Save index to disk
   */
  save(): boolean {
    if (!this.dirty) return false;

    try {
      const dir = dirname(this.config.cachePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data: PersistedIndex = {
        version: 2,
        savedAt: new Date().toISOString(),
        modelId: this.config.embeddingModel,
        chunks: Array.from(this.chunks.values()),
      };

      writeFileSync(this.config.cachePath, JSON.stringify(data), 'utf-8');
      this.dirty = false;

      if (process.env.DEBUG_SEMANTIC_MEMORY === '1') {
        process.stderr.write(`[semantic] Saved ${this.chunks.size} chunks\n`);
      }

      return true;
    } catch (e) {
      if (process.env.DEBUG_SEMANTIC_MEMORY === '1') {
        process.stderr.write(`[semantic] Save error: ${e}\n`);
      }
      return false;
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    enabled: boolean;
    chunkCount: number;
    fileCount: number;
    modelId: string;
    indexedWorkspace: string | null;
  } {
    return {
      enabled: this.config.enabled,
      chunkCount: this.chunks.size,
      fileCount: this.fileHashes.size,
      modelId: this.config.embeddingModel,
      indexedWorkspace: this.indexedWorkspace,
    };
  }

  /**
   * Clear all cached embeddings
   */
  clear(): void {
    this.chunks.clear();
    this.fileHashes.clear();
    this.indexedWorkspace = null;
    this.dirty = true;
    this.save();
  }

  /**
   * Enable or disable semantic memory
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * Check if LM Studio is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`${this.config.lmStudioBaseUrl}/v1/models`, {
          method: 'GET',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        return response.ok;
      } catch {
        clearTimeout(timeoutId);
        return false;
      }
    } catch {
      return false;
    }
  }
}

// Singleton instance
let semanticMemoryInstance: SemanticMemory | null = null;

/**
 * Get or create the singleton semantic memory instance
 */
export function getSemanticMemory(config?: Partial<SemanticMemoryConfig>): SemanticMemory {
  if (!semanticMemoryInstance) {
    semanticMemoryInstance = new SemanticMemory(config);
  }
  return semanticMemoryInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetSemanticMemory(): void {
  semanticMemoryInstance = null;
}
