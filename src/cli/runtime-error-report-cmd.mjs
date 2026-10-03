import { reportRuntimeErrors } from '../core/runtime-error-reporter.mjs';

export async function runRuntimeErrorReportCommand({ argv = [], write = (line) => process.stdout.write(line) } = {}) {
  if (argv.length !== 0) {
    const error = new Error('usage: spotter runtime-errors report');
    error.exitCode = 2;
    throw error;
  }
  let result;
  try { result = await reportRuntimeErrors(); }
  catch {
    result = { status: 'report_unavailable' };
  }
  write(`${JSON.stringify(result)}\n`);
  if (!['accepted', 'nothing_to_report', 'disabled'].includes(result.status)) process.exitCode = 1;
}
