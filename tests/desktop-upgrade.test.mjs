import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeDesktopTarget, desktopUpgradeResult, performDesktopHandoff, prepareDesktopUpdate } from '../desktop/upgrade.mjs';

const release = {
  currentVersion: '1.2.1', latestVersion: '9.0.0',
  downloads: { desktopPortable: 'https://github.com/Starry-cz/autodl-assistant/releases/download/v9.0.0/autodl-assistant-desktop-9.0.0-win-x64.zip' },
};
function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-desktop-upgrade-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(userData)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(userData).startsWith('autodl-desktop-upgrade-'));
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const runtimeDir = path.join(userData, 'runtime');
  fs.mkdirSync(runtimeDir);
  fs.writeFileSync(path.join(runtimeDir, 'state.json'), '{"syntheticTask":"keep"}');
  fs.writeFileSync(path.join(userData, 'local-port.json'), JSON.stringify({ port: 54321 }));
  const executable = path.join(userData, 'updates', 'desktop-9.0.0-fixture', 'app', 'AutoDL Assistant.exe');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'synthetic-executable');
  return { userData, runtimeDir, executable, version: '9.0.0', previousPid: 123, previousExecutable: path.join(userData, 'old.exe') };
}

test('桌面更新先下载及预检，路径通过环境变量传递，不触碰运行资料', async t => {
  const plan = fixture(t), progress = [], calls = [];
  const prepared = await prepareDesktopUpdate({ userData: plan.userData, release, report: value => progress.push(value), platform: 'win32', arch: 'x64',
    fetchImpl: async url => { assert.equal(url, release.downloads.desktopPortable); return new Response('synthetic zip', { headers: { 'content-length': '13' } }); },
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (file === 'powershell.exe') {
        const target = options.env.AUTODL_UPDATE_TARGET, root = path.join(target, 'resources', 'app');
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'autodl-gpu-watch', version: '9.0.0' }));
        fs.writeFileSync(path.join(target, 'AutoDL Assistant.exe'), 'synthetic');
      }
    },
  });
  assert.equal(prepared.version, '9.0.0');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'], '解压不得依赖用户已放开系统脚本策略');
  assert.equal(calls[1].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(calls.every(call => call.options.windowsHide));
  assert.equal(fs.readFileSync(path.join(plan.runtimeDir, 'state.json'), 'utf8'), '{"syntheticTask":"keep"}');
  assert.ok(progress.some(event => event.phase === 'prepare'));
  assert.equal(fs.existsSync(path.join(plan.userData, 'active-desktop.json')), false);
});

test('下载失败、非Windows x64和不匹配附件都不会继续解压或激活', async t => {
  const plan = fixture(t);
  let runs = 0;
  const args = { userData: plan.userData, release, report() {}, platform: 'win32', arch: 'x64', run: async () => { runs++; }, fetchImpl: async () => new Response('', { status: 503 }) };
  await assert.rejects(prepareDesktopUpdate(args), /HTTP 503/);
  await assert.rejects(prepareDesktopUpdate({ ...args, arch: 'arm64' }), /Windows x64/);
  await assert.rejects(prepareDesktopUpdate({ ...args, release: { ...release, downloads: { desktopPortable: 'https://example.com/anything.zip' } } }), /正式桌面新版/);
  assert.equal(runs, 0);
  assert.equal(fs.existsSync(path.join(plan.userData, 'active-desktop.json')), false);
});

test('交接等待旧进程退出和新版本健康确认，之后才激活旧快捷方式转发', async t => {
  const plan = fixture(t), launches = [];
  let oldChecks = 0, polls = 0;
  await performDesktopHandoff(plan, {
    alive: () => ++oldChecks < 3, sleep: async () => {}, attempts: 10,
    launch: async (executable, userData) => { launches.push({ executable, userData }); return { exitCode: null }; },
    fetchImpl: async () => {
      assert.equal(fs.existsSync(path.join(plan.userData, 'active-desktop.json')), false);
      return new Response(JSON.stringify({ app: 'autodl-assistant', ready: true, version: ++polls === 1 ? '1.2.1' : plan.version,
        runtimeDir: plan.runtimeDir, projectRoot: path.join(path.dirname(plan.executable), 'resources', 'app') }));
    },
  });
  assert.deepEqual(launches, [{ executable: plan.executable, userData: plan.userData }]);
  assert.equal(desktopUpgradeResult(plan.userData).status, 'complete');
  assert.equal(JSON.parse(fs.readFileSync(path.join(plan.runtimeDir, 'upgrade-status.json'), 'utf8')).status, 'complete');
  assert.equal(activeDesktopTarget({ ...plan, currentVersion: '1.2.1', executable: plan.previousExecutable }), plan.executable);
  assert.equal(activeDesktopTarget({ ...plan, currentVersion: '9.0.0' }), null);
  assert.equal(activeDesktopTarget({ ...plan, currentVersion: '10.0.0' }), null, '手动安装更高版本不能跳回较旧缓存');
  assert.equal(fs.readFileSync(path.join(plan.runtimeDir, 'state.json'), 'utf8'), '{"syntheticTask":"keep"}');
});

test('旧进程未退出不启动第二份，新版启动失败仅在退出后重开旧版', async t => {
  const plan = fixture(t), launches = [];
  const launch = async executable => { launches.push(executable); return { exitCode: 1 }; };
  await assert.rejects(performDesktopHandoff(plan, { alive: () => true, sleep: async () => {}, attempts: 2, launch }), /旧桌面后台仍未退出/);
  assert.deepEqual(launches, []);
  await assert.rejects(performDesktopHandoff(plan, { alive: () => false, sleep: async () => {}, attempts: 2, launch }), /新版桌面程序启动失败/);
  assert.deepEqual(launches, [plan.executable, plan.previousExecutable]);
  assert.equal(desktopUpgradeResult(plan.userData).status, 'error');
  assert.equal(JSON.parse(fs.readFileSync(path.join(plan.runtimeDir, 'upgrade-status.json'), 'utf8')).status, 'error');
  assert.equal(fs.existsSync(path.join(plan.userData, 'active-desktop.json')), false);
});

test('新版未响应但仍存活时不强杀或并行启动旧后台', async t => {
  const plan = fixture(t), launches = [];
  await assert.rejects(performDesktopHandoff(plan, {
    alive: () => false, sleep: async () => {}, attempts: 2,
    launch: async executable => { launches.push(executable); return { exitCode: null }; },
    fetchImpl: async () => { throw new TypeError('not listening'); },
  }), /未能完成启动/);
  assert.deepEqual(launches, [plan.executable]);
  assert.equal(fs.existsSync(path.join(plan.userData, 'active-desktop.json')), false);
});
