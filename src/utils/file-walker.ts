import { stat, readdir } from 'fs/promises';
import { join, relative } from 'path';

interface WalkEntry {
  path: string;
  isDirectory: boolean;
}

export async function walkDir(rootDir: string): Promise<WalkEntry[]> {
  const entries: WalkEntry[] = [];

  async function walk(currentDir: string): Promise<void> {
    try {
      const items = await readdir(currentDir);

      for (const item of items) {
        const fullPath = join(currentDir, item);
        const relativePath = relative(rootDir, fullPath);

        if (shouldSkip(relativePath, item)) continue;

        const entryStat = await stat(fullPath);

        if (entryStat.isDirectory()) {
          entries.push({ path: fullPath, isDirectory: true });
          await walk(fullPath);
        } else {
          entries.push({ path: fullPath, isDirectory: false });
        }
      }
    } catch {
      // Directory might not exist or be accessible
    }
  }

  await walk(rootDir);
  return entries;
}

function shouldSkip(relativePath: string, item: string): boolean {
  const skipPatterns = [
    'node_modules',
    '.git',
    '.opencode',
    'dist',
    'build',
    '.env',
    '.env.*',
    '*.log',
    '*.tmp',
    '*.swp',
    '*.swo',
    '.DS_Store',
    'Thumbs.db',
  ];

  for (const pattern of skipPatterns) {
    if (pattern.startsWith('*')) {
      if (item.endsWith(pattern.slice(1))) return true;
    } else if (pattern.includes('/')) {
      if (relativePath.includes(pattern)) return true;
    } else {
      if (item === pattern) return true;
    }
  }

  return false;
}
