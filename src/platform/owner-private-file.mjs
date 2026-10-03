import { constants } from 'node:fs';
import { chmod, lstat, open, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WINDOWS_POWERSHELL_COMMAND } from './spawn.mjs';

export async function readOwnerPrivateFile(path, { platform = process.platform } = {}) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('private file type is unsafe');
  if (platform === 'win32') await checkWindowsOwnerAcl(path);
  else if (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) {
    throw new Error('private file ownership or mode is unsafe');
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error('private file changed during read');
    }
    if (platform !== 'win32' && (opened.uid !== process.getuid() || (opened.mode & 0o777) !== 0o600)) {
      throw new Error('private file ownership or mode changed');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile());
  } finally {
    await handle.close();
  }
}

function checkWindowsOwnerAcl(path) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$admins = "S-1-5-32-544"',
    '$system = "S-1-5-18"',
    '$acl = Get-Acl -LiteralPath $env:SPOTTER_PRIVATE_FILE',
    '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
    '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
    '$unsafe = @($rules | Where-Object { $_.AccessControlType -eq "Allow" -and @($sid, $admins, $system) -notcontains $_.IdentityReference.Value })',
    'if (@($sid, $admins) -notcontains $owner -or $unsafe.Count -gt 0) { exit 7 }',
  ].join('; ');
  return runPowerShellFileScript(path, script);
}

export async function writeOwnerPrivateFile(path, content, { platform = process.platform } = {}) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    if (platform === 'win32') {
      const script = [
        '$ErrorActionPreference = "Stop"',
        '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
        '$acl = Get-Acl -LiteralPath $env:SPOTTER_PRIVATE_FILE',
        '$acl.SetOwner($sid)',
        '$acl.SetAccessRuleProtection($true, $false)',
        '$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, "FullControl", [System.Security.AccessControl.InheritanceFlags]::None, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)',
        '$acl.AddAccessRule($rule)',
        'Set-Acl -LiteralPath $env:SPOTTER_PRIVATE_FILE -AclObject $acl',
      ].join('; ');
      await runPowerShellFileScript(temporary, script);
      await checkWindowsOwnerAcl(temporary);
    } else await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function runPowerShellFileScript(path, script) {
  return new Promise((resolve, reject) => {
    const child = spawn(WINDOWS_POWERSHELL_COMMAND, ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore', windowsHide: true,
      env: { ...process.env, SPOTTER_PRIVATE_FILE: path },
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error('private file ACL is unsafe'));
    });
  });
}
