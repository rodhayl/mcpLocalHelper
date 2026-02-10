#!/usr/bin/env node
/**
 * Prune runtime artifact directories that can grow over time:
 * - .mcp-backups
 * - .orchestration-plans
 *
 * Defaults are intentionally conservative for production use.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const defaults = {
    dryRun: false,
    backupMaxAgeDays: 14,
    backupMaxFiles: 1000,
    planMaxAgeDays: 14,
    planMaxCount: 200,
    removeTestBackups: true,
  };

  const args = { ...defaults };
  for (const raw of argv) {
    if (raw === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (raw === '--keep-test-backups') {
      args.removeTestBackups = false;
      continue;
    }

    const [flag, value] = raw.split('=');
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) continue;

    if (flag === '--backup-max-age-days') args.backupMaxAgeDays = parsed;
    if (flag === '--backup-max-files') args.backupMaxFiles = Math.max(0, Math.floor(parsed));
    if (flag === '--plan-max-age-days') args.planMaxAgeDays = parsed;
    if (flag === '--plan-max-count') args.planMaxCount = Math.max(0, Math.floor(parsed));
  }

  return args;
}

function toRel(targetPath) {
  return path.relative(repoRoot, targetPath).replace(/\\/g, '/');
}

function walkFiles(rootDir, predicate = () => true) {
  if (!fs.existsSync(rootDir)) return [];
  const out = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && predicate(full)) {
        out.push(full);
      }
    }
  }

  return out;
}

function removeEmptyDirs(rootDir, dryRun) {
  if (!fs.existsSync(rootDir)) return 0;
  let removed = 0;

  function recurse(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        recurse(path.join(dirPath, entry.name));
      }
    }

    if (dirPath === rootDir) return;
    const after = fs.readdirSync(dirPath);
    if (after.length === 0) {
      if (!dryRun) fs.rmdirSync(dirPath);
      removed++;
      console.log(
        `[cleanup:runtime] ${dryRun ? 'would remove' : 'removed'} empty dir ${toRel(dirPath)}`
      );
    }
  }

  recurse(rootDir);
  return removed;
}

function removePath(targetPath, dryRun) {
  if (!fs.existsSync(targetPath)) return false;
  if (!dryRun) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
  console.log(`[cleanup:runtime] ${dryRun ? 'would remove' : 'removed'} ${toRel(targetPath)}`);
  return true;
}

function pruneBackups(opts) {
  const backupsRoot = path.join(repoRoot, '.mcp-backups');
  if (!fs.existsSync(backupsRoot)) return { removedFiles: 0, removedDirs: 0 };

  let removedFiles = 0;
  const now = Date.now();
  const maxAgeMs = Math.max(0, opts.backupMaxAgeDays) * 24 * 60 * 60 * 1000;

  if (opts.removeTestBackups) {
    const testBackupsDir = path.join(backupsRoot, 'tests');
    const testFiles = walkFiles(testBackupsDir, (p) => p.endsWith('.bak'));
    if (removePath(testBackupsDir, opts.dryRun)) {
      removedFiles += testFiles.length;
    }
  }

  let bakFiles = walkFiles(backupsRoot, (p) => p.endsWith('.bak')).map((filePath) => {
    const stat = fs.statSync(filePath);
    return {
      filePath,
      mtimeMs: stat.mtimeMs,
    };
  });

  for (const file of bakFiles) {
    if (now - file.mtimeMs > maxAgeMs) {
      if (!opts.dryRun) fs.unlinkSync(file.filePath);
      removedFiles++;
      console.log(
        `[cleanup:runtime] ${opts.dryRun ? 'would remove' : 'removed'} old backup ${toRel(file.filePath)}`
      );
    }
  }

  bakFiles = walkFiles(backupsRoot, (p) => p.endsWith('.bak')).map((filePath) => {
    const stat = fs.statSync(filePath);
    return {
      filePath,
      mtimeMs: stat.mtimeMs,
    };
  });

  if (bakFiles.length > opts.backupMaxFiles) {
    bakFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toDelete = bakFiles.slice(opts.backupMaxFiles);
    for (const file of toDelete) {
      if (!opts.dryRun) fs.unlinkSync(file.filePath);
      removedFiles++;
      console.log(
        `[cleanup:runtime] ${opts.dryRun ? 'would remove' : 'removed'} overflow backup ${toRel(file.filePath)}`
      );
    }
  }

  const removedDirs = removeEmptyDirs(backupsRoot, opts.dryRun);
  return { removedFiles, removedDirs };
}

function listPlanDirs(plansRoot) {
  if (!fs.existsSync(plansRoot)) return [];
  return fs
    .readdirSync(plansRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('plan_'))
    .map((entry) => {
      const planDir = path.join(plansRoot, entry.name);
      const stat = fs.statSync(planDir);
      return {
        planDir,
        mtimeMs: stat.mtimeMs,
      };
    });
}

function prunePlans(opts) {
  const plansRoot = path.join(repoRoot, '.orchestration-plans');
  if (!fs.existsSync(plansRoot)) return { removedPlans: 0, removedFiles: 0, removedDirs: 0 };

  const now = Date.now();
  const maxAgeMs = Math.max(0, opts.planMaxAgeDays) * 24 * 60 * 60 * 1000;
  let removedPlans = 0;
  let removedFiles = 0;

  let planDirs = listPlanDirs(plansRoot);

  for (const plan of planDirs) {
    if (now - plan.mtimeMs > maxAgeMs) {
      const fileCount = walkFiles(plan.planDir).length;
      if (!opts.dryRun) fs.rmSync(plan.planDir, { recursive: true, force: true });
      removedPlans++;
      removedFiles += fileCount;
      console.log(
        `[cleanup:runtime] ${opts.dryRun ? 'would remove' : 'removed'} old plan ${toRel(plan.planDir)}`
      );
    }
  }

  planDirs = listPlanDirs(plansRoot);
  if (planDirs.length > opts.planMaxCount) {
    planDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toDelete = planDirs.slice(opts.planMaxCount);
    for (const plan of toDelete) {
      const fileCount = walkFiles(plan.planDir).length;
      if (!opts.dryRun) fs.rmSync(plan.planDir, { recursive: true, force: true });
      removedPlans++;
      removedFiles += fileCount;
      console.log(
        `[cleanup:runtime] ${opts.dryRun ? 'would remove' : 'removed'} overflow plan ${toRel(plan.planDir)}`
      );
    }
  }

  const leftoverTmpFiles = walkFiles(plansRoot, (p) => p.endsWith('.tmp'));
  for (const filePath of leftoverTmpFiles) {
    if (!opts.dryRun) fs.unlinkSync(filePath);
    removedFiles++;
    console.log(
      `[cleanup:runtime] ${opts.dryRun ? 'would remove' : 'removed'} tmp file ${toRel(filePath)}`
    );
  }

  const removedDirs = removeEmptyDirs(plansRoot, opts.dryRun);
  return { removedPlans, removedFiles, removedDirs };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const backupStats = pruneBackups(opts);
  const planStats = prunePlans(opts);

  console.log('[cleanup:runtime] summary');
  console.log(
    JSON.stringify(
      {
        dryRun: opts.dryRun,
        backups: backupStats,
        plans: planStats,
      },
      null,
      2
    )
  );
}

main();
