#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
try {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const content = fs.readFileSync(pkgPath, 'utf8');
  JSON.parse(content); // will throw on invalid JSON
  console.log('OK: package.json is valid JSON');
  process.exit(0);
} catch (err) {
  console.error('ERR: package.json is invalid JSON');
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
}
