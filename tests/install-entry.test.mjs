import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Windows 启停入口保留 CRLF，避免下载 ZIP 后 CMD 截断中文命令', () => {
  // Git archive 不执行 eol 转换，工作文件及提交内容必须直接保存 Windows 换行。
  for (const name of fs.readdirSync(root).filter(name => name.endsWith('.cmd'))) {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    assert.ok(!text.startsWith('\uFEFF'), name + ' 不应包含 BOM');
    assert.ok(text.includes('\r\n'), name + ' 应有 CRLF 换行');
    assert.ok(!/(?<!\r)\n/.test(text), name + ' 不应包含单独 LF');
  }
});

test('安装与启停 PowerShell 文件可由 Windows PowerShell 5.1 解析', { skip: process.platform !== 'win32' }, () => {
  const files = ['install.ps1', 'scripts/start-local.ps1', 'scripts/stop-local.ps1', 'scripts/node-runtime.ps1'];
  for (const name of files) {
    // 中文脚本保留 BOM，让 Windows 自带 PowerShell 使用正确编码读取。
    assert.equal(fs.readFileSync(path.join(root, name), 'utf8').charAt(0), '\uFEFF', name);
  }
  const command = "$t=$null;$e=$null;foreach($f in @('" + files.join("','") + "')){[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) $f),[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|Out-String|Write-Error;exit 1}}";
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Command', command], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
