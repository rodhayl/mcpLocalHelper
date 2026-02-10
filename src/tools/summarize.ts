import { Summary, ChatMessage, SummarySource } from '../types/index.js';
import { FileTools } from './file.js';
import { LlmChatTool } from './llm.js';
import { RedactionEngine } from '../utils/redaction.js';
import { statSync } from 'fs';
import { ToolLlmWrapper } from '../orchestration/tool-llm-wrapper.js';

export class SummarizationTools {
  private fileTools: FileTools;
  private redaction: RedactionEngine;
  private llmWrapper: ToolLlmWrapper;

  constructor(fileTools: FileTools, llmChat: LlmChatTool) {
    this.fileTools = fileTools;
    this.redaction = new RedactionEngine();
    this.llmWrapper = new ToolLlmWrapper(llmChat);
  }

  private isPlaceholderSummary(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (trimmed.length < 24) return true;

    const lower = trimmed.toLowerCase();
    const patterns = [
      /summary (?:was|has been)? (?:produced|generated)/i,
      /raw text .* not (?:completed|available)/i,
      /file was read and summarized/i,
      /summary not available/i,
      /unable to access/i,
      /as an ai/i,
      /cannot (?:access|read) the file/i,
    ];

    return patterns.some((p) => p.test(lower));
  }

  private buildFallbackFileSummary(
    path: string,
    content: string,
    mode: 'compact' | 'extended'
  ): string {
    const lines = content.split('\n');
    const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
    const heading = nonEmpty.find((l) => l.startsWith('#'))?.replace(/^#+\s*/, '') || '';
    const firstLine = nonEmpty[0] || '';
    const secondLine = nonEmpty[1] || '';
    const signatures = lines
      .map((l) => l.trim())
      .filter(
        (l) => /^(export\s+)?(async\s+)?(function|class)\s+\w+/.test(l) || /^def\s+\w+\s*\(/.test(l)
      )
      .slice(0, mode === 'compact' ? 3 : 8);

    const parts = [heading, firstLine, secondLine].filter(Boolean);
    const coreSummary =
      parts.length > 0 ? parts.join(' ') : `File ${path} contains ${lines.length} lines.`;
    const signatureSummary =
      signatures.length > 0 ? `Key definitions: ${signatures.join(', ')}.` : '';

    return [coreSummary, signatureSummary].filter(Boolean).join(' ');
  }

  private buildFallbackDirectorySummary(
    path: string,
    entries: Array<{ name: string; type: string }>,
    mode: 'compact' | 'extended'
  ): string {
    const maxEntries = mode === 'compact' ? 10 : 20;
    const listed = entries
      .slice(0, maxEntries)
      .map((e) => (e.type === 'directory' ? `${e.name}/` : e.name));
    const suffix = entries.length > maxEntries ? ` (+${entries.length - maxEntries} more)` : '';
    return `Directory ${path} contains ${entries.length} entries. Key items: ${listed.join(', ')}${suffix}.`;
  }

  private buildFallbackRepoSummary(
    root: string,
    components: string[],
    keyFiles: string[],
    mode: 'compact' | 'extended'
  ): string {
    const maxComponents = mode === 'compact' ? 12 : 24;
    const maxKeys = mode === 'compact' ? 5 : 10;
    const componentPreview = components.slice(0, maxComponents);
    const keyPreview = keyFiles.slice(0, maxKeys);
    const componentSuffix =
      components.length > maxComponents ? ` (+${components.length - maxComponents} more)` : '';
    return (
      `Repository ${root} contains ${components.length} top-level entries. ` +
      `Top entries: ${componentPreview.join(', ')}${componentSuffix}. ` +
      `${keyPreview.length > 0 ? `Key files: ${keyPreview.join(', ')}.` : ''}`
    );
  }

  async summarizePath(path: string, mode: 'compact' | 'extended'): Promise<Summary> {
    try {
      // Check if path is a file or directory
      const resolvedPath = this.fileTools.resolvePath(path);
      let stats;
      try {
        stats = statSync(resolvedPath);
      } catch (error) {
        if (error instanceof Error && (error as any).code === 'ENOENT') {
          return {
            summary: `Path not found: '${path}' does not exist. Resolved to: '${resolvedPath}'. Please verify the path is correct and within the workspace.`,
            mode,
          };
        }
        throw error;
      }

      if (stats.isDirectory()) {
        return await this.summarizeDirectory(path, mode);
      }

      // Handle file summarization
      const fileContent = this.fileTools.readFile(path, mode === 'compact' ? 16384 : 65536); // 16KB or 64KB

      // V15: Enhanced system prompts with stronger grounding to prevent mischaracterization
      // Addresses feedback: "summarize tool mischaracterizes apps (called Tkinter desktop app a 'web app')"
      const systemPrompt =
        mode === 'compact'
          ? `You are a precise code analyst. Summarize ONLY what is explicitly present in this file.

CRITICAL RULES:
1. Do NOT guess or assume technologies not shown in the code
2. If you see "tkinter" or "Tk()", it's a DESKTOP app, NOT a web app
3. If you see "Flask", "Django", "FastAPI", it's a web framework
4. If you see "React", "Vue", "Angular", it's a frontend framework
5. Only mention frameworks/libraries that are explicitly imported
6. Keep summary to 2-3 sentences focused on what the file ACTUALLY does
7. Return ONLY the summary text (no meta statements about reading or summarizing)`
          : `You are a precise code analyst. Provide a detailed summary based ONLY on what is explicitly present in this file.

CRITICAL RULES:
1. Do NOT guess or assume technologies not shown in the code
2. Identify the ACTUAL technology stack from imports/requires
3. If you see "tkinter" or "Tk()", it's a DESKTOP GUI app (NOT web)
4. If you see "Flask/Django/FastAPI", it's a web framework
5. If you see "React/Vue/Angular", it's a frontend framework
6. Only list features/capabilities that are ACTUALLY implemented
7. Return ONLY the summary text (no meta statements about reading or summarizing)

Include in your summary:
1) Main purpose (based on actual code, not guesses)
2) Key functions/classes (list what EXISTS)
3) Technology stack (ONLY from actual imports)
4) Important patterns or logic you can SEE`;

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: `Please summarize the following file content. Remember: ONLY describe what is explicitly in the code, do not assume or guess.\n\nPath: ${path}\n\nContent:\n${fileContent.content}`,
        },
      ];

      const responseText = await this.llmWrapper.callToolLlm('summarize', messages, {
        type: 'summarize_file',
        path,
        mode,
      });

      // Strip <think> tags from LLM response
      const cleanedContent = this.redaction.stripThinkTags(responseText);
      const usedFallback = this.isPlaceholderSummary(cleanedContent);
      const summary = usedFallback
        ? this.buildFallbackFileSummary(path, fileContent.content, mode)
        : cleanedContent;

      return {
        summary,
        mode,
        ...(usedFallback
          ? {
              notice: 'LLM response was generic; returned heuristic summary based on file content.',
            }
          : {}),
      };
    } catch (error) {
      return {
        summary: `Error summarizing path: ${error instanceof Error ? error.message : 'Unknown error'}`,
        mode,
      };
    }
  }

  private async summarizeDirectory(path: string, mode: 'compact' | 'extended'): Promise<Summary> {
    try {
      const dirList = this.fileTools.listDirectory(path, mode === 'compact' ? 20 : 50);
      const components: string[] = [];
      const fileInfo: string[] = [];

      for (const entry of dirList.entries) {
        components.push(entry.name);
        fileInfo.push(`- ${entry.name} (${entry.type})`);
      }

      // V15: Enhanced prompts with grounding constraints
      const systemPrompt =
        mode === 'compact'
          ? `You are a precise code analyst. Summarize this directory based ONLY on what you can see in the file listing.

CRITICAL RULES:
1. Do NOT assume technologies not evident from filenames
2. If you see .py files, it MAY be Python (but don't assume Flask/Django without evidence)
3. If you see package.json, it's a Node.js project
4. Keep summary to 2-3 sentences about ACTUAL visible structure
5. Return ONLY the summary text (no meta statements about reading or summarizing)`
          : `You are a precise code analyst. Summarize this directory based ONLY on what you can see in the file listing.

CRITICAL RULES:
1. Do NOT assume technologies not evident from filenames
2. Only mention frameworks if config files indicate them (package.json, requirements.txt, etc.)
3. Describe actual files/folders you see, not what you think might be there
4. Return ONLY the summary text (no meta statements about reading or summarizing)

Include:
1) Main purpose (inferred from visible files ONLY)
2) Key files and their LIKELY purposes (based on names)
3) Subdirectories and their probable roles
4) Organization pattern you can OBSERVE`;

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: `Please summarize the following directory. Remember: ONLY describe what is visible in this listing.\n\nPath: ${path}\n\nContents:\n${fileInfo.join('\n')}`,
        },
      ];

      const responseText = await this.llmWrapper.callToolLlm('summarize', messages, {
        type: 'summarize_directory',
        path,
        mode,
      });

      // Strip <think> tags from LLM response
      const cleanedContent = this.redaction.stripThinkTags(responseText);
      const usedFallback = this.isPlaceholderSummary(cleanedContent);
      const summary = usedFallback
        ? this.buildFallbackDirectorySummary(path, dirList.entries, mode)
        : cleanedContent;

      return {
        summary,
        mode,
        components,
        ...(usedFallback
          ? {
              notice:
                'LLM response was generic; returned heuristic summary based on directory listing.',
            }
          : {}),
      };
    } catch (error) {
      return {
        summary: `Error summarizing directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
        mode,
      };
    }
  }

  async summarizeRepo(root: string, mode: 'compact' | 'extended'): Promise<Summary> {
    try {
      // V17: Pre-flight size check to prevent timeouts on large repos
      // Addresses QA feedback: "summarize on root repo timed out"
      const rootMaxEntries = mode === 'compact' ? 200 : 500;
      const rootDir = this.fileTools.listDirectory(root, rootMaxEntries);

      // Count total files/dirs to assess size
      const dirCount = rootDir.entries.filter((e) => e.type === 'directory').length;
      const totalEntries = rootDir.entries.length;

      // If repo appears too large, note it but continue with a bounded summary
      const MAX_SAFE_DIRS = 50;
      const MAX_SAFE_TOTAL = 150;
      const sizeNotice =
        dirCount > MAX_SAFE_DIRS || totalEntries > MAX_SAFE_TOTAL
          ? `Pre-flight check: ${totalEntries} root entries exceeds safe limit of ${MAX_SAFE_TOTAL}. ` +
            `To avoid timeouts, summarize subdirectories separately.`
          : '';

      const keyFiles: string[] = [];
      const components: string[] = [];

      // Record a broader (but bounded) view of the repo root so summaries don't look incomplete.
      for (const entry of rootDir.entries) {
        components.push(entry.type === 'directory' ? `${entry.name}/` : entry.name);
      }

      // Identify key files and directories
      for (const entry of rootDir.entries) {
        if (entry.type === 'file') {
          if (this.isKeyFile(entry.name)) {
            keyFiles.push(entry.name);
          }
        } else if (entry.type === 'directory') {
          if (this.isKeyDirectory(entry.name)) {
            // Look for key files in subdirectories
            try {
              const subDir = this.fileTools.listDirectory(`${root}/${entry.name}`, 10);
              for (const subEntry of subDir.entries) {
                if (subEntry.type === 'file' && this.isKeyFile(subEntry.name)) {
                  keyFiles.push(`${entry.name}/${subEntry.name}`);
                }
              }
            } catch {
              // Skip directories we can't read
            }
          }
        }
      }

      // Summarize key files and track provenance sources
      const fileSummaries: string[] = [];
      const sources: SummarySource[] = [];
      const keyFilesProcessed = keyFiles.slice(0, mode === 'compact' ? 3 : 8);

      for (const file of keyFilesProcessed) {
        try {
          const summary = await this.summarizePath(`${root}/${file}`, 'compact');
          fileSummaries.push(`## ${file}\n${summary.summary}`);

          // Plan 4 (V6): Add provenance source for each key file
          // Read first few lines as excerpt for provenance
          try {
            const fileContent = this.fileTools.readFile(`${root}/${file}`, 512);
            const excerpt = fileContent.content.split('\n').slice(0, 5).join('\n');
            sources.push({
              file,
              startLine: 1,
              endLine: Math.min(5, fileContent.content.split('\n').length),
              excerpt: excerpt.substring(0, 240),
              confidence: 0.8, // High confidence for actual file content
            });
          } catch {
            // Still add source without excerpt
            sources.push({
              file,
              excerpt: summary.summary.substring(0, 240),
              confidence: 0.6, // Medium confidence for LLM summary only
            });
          }
        } catch (error) {
          fileSummaries.push(
            `## ${file}\n[Could not summarize: ${error instanceof Error ? error.message : 'Unknown error'}]`
          );
        }
      }

      // Look for package files to understand dependencies
      let dependencies = '';
      try {
        if (keyFiles.includes('package.json')) {
          const packageContent = this.fileTools.readFile(`${root}/package.json`, 8192);
          const pkg = JSON.parse(packageContent.content);
          const deps = Object.keys(pkg.dependencies || {});
          if (deps.length > 0) {
            dependencies = `Key dependencies: ${deps.slice(0, 10).join(', ')}${deps.length > 10 ? '...' : ''}`;
          }
        }
      } catch {
        // Ignore package.json parsing errors
      }

      const systemPrompt =
        mode === 'compact'
          ? 'You are a code analyst. Summarize the repository based ONLY on the information provided below. Do NOT invent or hallucinate features, files, or capabilities that are not explicitly mentioned in the context. If limited information is available, say so. Provide a brief 3-4 sentence summary focusing on the main purpose, technology stack, and key components ACTUALLY FOUND. Return ONLY the summary text (no meta statements about reading or summarizing).'
          : 'You are a code analyst. Summarize the repository based ONLY on the information provided below. Do NOT invent or hallucinate features, files, or capabilities that are not explicitly mentioned in the context. Include: 1) Main purpose and functionality (from README/package.json), 2) Technology stack and dependencies (ONLY from package.json if shown), 3) Key directories and their purposes (ONLY what was discovered), 4) Important patterns or architecture (ONLY from file summaries shown), 5) Build/development setup (ONLY if evident from scripts/config). Return ONLY the summary text (no meta statements about reading or summarizing).';

      // Build a grounded context that prevents hallucination
      const componentsPreviewLimit = mode === 'compact' ? 60 : 120;
      const componentsPreview =
        components.length > componentsPreviewLimit
          ? `${components.slice(0, componentsPreviewLimit).join(', ')} … (+${components.length - componentsPreviewLimit} more)`
          : components.join(', ');
      const contextParts: string[] = [
        `Repository root: ${root}`,
        '',
        `Discovered directories and files: ${componentsPreview || '(none found)'}`,
      ];
      if (dependencies) {
        contextParts.push('', dependencies);
      }
      if (fileSummaries.length > 0) {
        contextParts.push('', 'Key files analyzed:', ...fileSummaries);
      } else {
        contextParts.push('', 'No key files were found or could be analyzed.');
      }

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: `Based on the following ACTUAL discoveries (do not invent anything not listed), summarize this repository:\n\n${contextParts.join('\n')}`,
        },
      ];

      const responseText = await this.llmWrapper.callToolLlm('summarize', messages, {
        type: 'summarize_repo',
        root,
        mode,
      });

      // Strip <think> tags from LLM response
      const cleanedContent = this.redaction.stripThinkTags(responseText);
      const usedFallback = this.isPlaceholderSummary(cleanedContent);
      const summary = usedFallback
        ? this.buildFallbackRepoSummary(root, components, keyFilesProcessed, mode)
        : cleanedContent;

      // Plan 4 (V6): Calculate provenance coverage
      const provenanceCoverage =
        keyFilesProcessed.length > 0 ? sources.length / keyFilesProcessed.length : 0;

      const notices = [
        sizeNotice,
        usedFallback
          ? 'LLM response was generic; returned heuristic summary based on repository structure.'
          : '',
      ].filter(Boolean);

      return {
        summary,
        mode,
        components,
        sources,
        provenanceCoverage,
        ...(notices.length > 0 ? { notice: notices.join(' ') } : {}),
      };
    } catch (error) {
      return {
        summary: `Error summarizing repository: ${error instanceof Error ? error.message : 'Unknown error'}`,
        mode,
      };
    }
  }

  private isKeyFile(filename: string): boolean {
    const keyFiles = [
      'package.json',
      'Cargo.toml',
      'pyproject.toml',
      'requirements.txt',
      'README.md',
      'readme.md',
      'README.rst',
      'Dockerfile',
      'docker-compose.yml',
      'tsconfig.json',
      'webpack.config.js',
      'vite.config.ts',
      '.env.example',
      '.gitignore',
      'main.py',
      'app.py',
      'server.js',
      'index.js',
      'index.ts',
      'Makefile',
      'build.gradle',
      'pom.xml',
    ];

    return keyFiles.some((pattern) => filename.toLowerCase().includes(pattern.toLowerCase()));
  }

  private isKeyDirectory(dirname: string): boolean {
    const keyDirs = [
      'src',
      'lib',
      'app',
      'components',
      'pages',
      'routes',
      'api',
      'backend',
      'frontend',
      'server',
      'client',
      'tests',
      'test',
      'spec',
      '__tests__',
      'config',
      'configs',
      'scripts',
      'tools',
      'utils',
      'docs',
      'documentation',
      'examples',
    ];

    return keyDirs.some((pattern) => dirname.toLowerCase().includes(pattern.toLowerCase()));
  }
}
