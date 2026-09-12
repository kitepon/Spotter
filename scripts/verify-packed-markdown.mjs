#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execFileWindowsSafe } from '../src/platform/spawn.mjs';
import {
  missingPackedMarkdownTargets,
  relativeMarkdownLinkTargets,
} from './markdown-link-targets.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packed = await execFileWindowsSafe(
  'npm',
  ['pack', '--dry-run', '--ignore-scripts', '--json'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);

let report;
try {
  report = JSON.parse(packed.stdout);
} catch (error) {
  throw new Error(`npm pack --dry-run did not return JSON: ${error.message}`);
}
const packageReport = Array.isArray(report) && report.length === 1
  ? report[0] : report?.['claude-spotter'];
if (!Array.isArray(packageReport?.files)) {
  throw new Error('npm pack --dry-run returned an unexpected report shape');
}

const packedPaths = new Set(packageReport.files.map(({ path: packedPath }) => packedPath));
const markdownPaths = [...packedPaths].filter((packedPath) => packedPath.endsWith('.md')).sort();
const failures = [];
let checkedTargets = 0;

for (const markdownPath of markdownPaths) {
  const text = await readFile(path.join(ROOT, ...markdownPath.split('/')), 'utf8');
  for (const { target } of missingPackedMarkdownTargets({
    markdownPath,
    markdown: text,
    packedPaths,
  })) {
    failures.push(`${markdownPath}: packed relative target is missing: ${target}`);
  }
  checkedTargets += relativeMarkdownLinkTargets(text).length;
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(
  `packed Markdown closure: ok (${markdownPaths.length} Markdown files, `
  + `${checkedTargets} relative targets, ${packedPaths.size} packed files)\n`,
);
