import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { testConfig } from './fixtures/config.mjs';
import { fixture as engineFixture } from './helpers.mjs';

const row = (id, { model = 'RTX 4090', available = 2, price = 1 } = {}) => ({ id,
  cells: ['', '101机', model, available + ' / 8', 'CPU：8核', '合成 CPU', '可扩容：1000GB', '驱动：550 CUDA：12.8', `￥${price} /时`] });

// 内存中的分页列表和准备表单：使用真实 prepare/locateHost/scanHosts，不启动浏览器或点击付费按钮。
function fixture(mode, pages, index = 1) {
  const adapter = new AutoDLBrowserAdapter('unused-isolated-prepare-profile');
  const config = testConfig({ mode, action: 'execute', paidConsent: true, copyDataDisk: false });
  const task = { id: 'synthetic-task', config };
  const source = { id: config.sourceId, region: '北京B区', gpuModel: 'RTX 4090', gpuCount: 1,
    stopped: true, extraDiskGB: 0, sourceCuda: '12.1' };
  const view = { index, firstClicks: 0, nextClicks: 0, selected: [], baselineClosed: 0, reads: 0 };
  const visible = () => pages[view.index];
  adapter.settle = async () => {};
  adapter.selectModel = async () => {};
  adapter.radio = async name => { if (name === 'target') view.selected.push(name); };
  adapter.canReuseProbe = () => true;
  adapter.startBaseline = async () => ({ collect: async () => mode === 'clone' ? [source] : [],
    close: async () => { view.baselineClosed++; } });
  adapter.checkbox = async (_control, checked) => { assert.equal(checked, false); };
  adapter.checkGpuCountKept = async count => { assert.equal(count, 1); };
  adapter.selectImage = async () => config.imagePath.join(' / ');
  adapter.submitButton = async () => ({ isEnabled: async () => true, click: async () => assert.fail('准备测试不能提交') });
  adapter.radioLabel = id => ({ count: async () => visible().some(item => item.id === id) ? 1 : 0, scrollIntoViewIfNeeded: async () => {} });
  adapter.page = {
    url: () => mode === 'clone' ? 'https://www.autodl.com/cloneInstance?id=synthetic-source&copy_data_disk=&use_address=' : 'https://www.autodl.com/create',
    locator(selector) {
      if (selector === 'table tbody tr') return { evaluateAll: async () => { view.reads++; return visible(); } };
      if (selector === '.el-pagination .btn-next:visible') return { count: async () => pages.length > 1 ? 1 : 0,
        isEnabled: async () => view.index < pages.length - 1,
        click: async () => { view.nextClicks++; view.index++; } };
      if (selector === '.el-pagination .number') return { filter: () => ({ count: async () => 1,
        first: () => ({ click: async () => { view.firstClicks++; view.index = 0; } }) }) };
      if (selector === '.el-table__body-wrapper') return { evaluateAll: async () => false };
      if (selector === 'label.el-checkbox') return { filter: () => ({}) };
      if (selector === 'body') return { innerText: async () => '配置费用：￥1.00/时\n日常费用：￥0.00/日' };
      throw Error('unexpected synthetic locator: ' + selector);
    },
  };
  return { adapter, task, source, view, prepare: () => adapter.prepare(task, { id: 'target', region: '北京B区' }, mode === 'clone' ? source : null) };
}

test('新建与克隆候选移到前页时仍能准确找回并完成报价准备', async () => {
  for (const mode of ['create', 'clone']) {
    const f = fixture(mode, [[row('target')], [row('other')]]);
    const quote = await f.prepare();
    assert.equal(quote.host.id, 'target'); assert.equal(quote.host.available, 2);
    assert.equal(quote.hourly, 1); assert.equal(quote.imageVerified, true);
    assert.equal(f.view.firstClicks, 1); assert.equal(f.view.nextClicks, 0);
    assert.equal(f.view.reads, 1); assert.deepEqual(f.view.selected, ['target']);
    assert.equal(f.view.baselineClosed, 1);
  }
});

test('当前页候选不回第一页；移到后页也只选择目标主机', async () => {
  const current = fixture('create', [[row('other')], [row('target')]]);
  assert.equal((await current.prepare()).host.id, 'target');
  assert.equal(current.view.firstClicks, 0); assert.equal(current.view.nextClicks, 0);
  const later = fixture('create', [[row('other0')], [row('other1')], [row('target')]]);
  assert.equal((await later.prepare()).host.id, 'target');
  assert.deepEqual(later.view.selected, ['target']); assert.equal(later.view.nextClicks, 2);
});

test('候选已消失或前页库存/型号/价格变差时仍拒绝，不选择替代主机', async () => {
  for (const mode of ['create', 'clone']) for (const candidate of [null, row('target', { available: 0 }),
    row('target', { model: 'RTX 4090D' }), row('target', { price: 100 })]) {
    const f = fixture(mode, [[candidate || row('other0')], [row('other1')]]);
    await assert.rejects(f.prepare(), error => error.code === 'RESOURCE_GONE');
    assert.deepEqual(f.view.selected, []); assert.equal(f.adapter.prepared, null);
    assert.equal(f.view.baselineClosed, 1);
  }
});

// 使用真实 prepare/locateHost 的异常进入任务引擎，确认普通库存竞争不会触发错误退避。
test('准备时确认候选消失属于普通竞争，不增加错误计数或翻倍等待', async t => {
  const gone = fixture('create', [[row('other0')], [row('other1')]]);
  const f = engineFixture(t, { mode: 'create', availableAfter: 0, pollSeconds: 10 });
  f.adapter.prepare = () => gone.prepare();
  const started = f.clock();
  await f.engine.tick();
  assert.equal(f.task.state, 'watching'); assert.equal(f.task.errors, 0);
  assert.equal(f.task.raceLosses, 1); assert.equal(f.task.nextCheckAt, started + 10000);
  assert.equal(f.submissions, 0); assert.deepEqual(gone.view.selected, []);
});
