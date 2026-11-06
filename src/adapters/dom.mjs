import { REGIONS } from '../config.mjs';
import { gpuKey } from '../matching.mjs';
const number = value => value == null ? null : Number(value);
// 保留完整型号及显存/接口后缀，不把 A100 80GB、4090D 等降级为基础型号。
const knownGpuLine = /^(?:(?:NVIDIA|Tesla|GeForce|Quadro)\s+)*(?:(?:RTX|GTX)\s*(?:PRO\s*)?[A-Z]?\d{3,5}|TITAN(?:\s+[XVZ])?|vGPU(?:\s*[-_]?\s*\d+)?|[ABHVLTP]\d{1,4})[A-Z0-9 .+()（）/_-]*$/i;
const knownGpuSuffix = new RegExp('(?:^|\\s)(' + knownGpuLine.source.slice(1, -1) + ')$', 'i');
const sameModel = (actual, expected) => typeof expected === 'string' && !!expected && gpuKey(actual) === gpuKey(expected);
function uniqueModel(models) {
  const unique = new Map(models.map(model => [gpuKey(model), model]));
  return unique.size === 1 ? [...unique.values()][0] : '';
}
export function parseGpuStockLabel(text) {
  // 只剥离末尾完整库存 (空闲/总数)，型号本身的 (48GB) 等括号必须保留。
  const match = String(text || '').trim().match(/^(.+?)\s*[(（]\s*(\d+)\s*\/\s*(\d+)\s*[)）]\s*$/);
  return match ? { gpuModel: match[1].trim(), available: Number(match[2]), total: Number(match[3]) } : null;
}
export function parseHostRow(raw, region, expectedModel = '') {
  const cells = raw.cells || [], text = cells.join('\n');
  // 主机 ID 可能以 a1/b2 开头，外形会撞上 GPU 型号正则；身份格不能参与型号识别。
  const lines = cells.filter(cell => cell.trim() !== raw.id && !/(?:^|\n)\s*CPU[：:]/i.test(cell))
    .flatMap(cell => cell.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  // 自定义型号也必须在页面上有整行精确证据；绝不回填用户要求的型号。
  // 明细查看“全部型号”时接受当地区域官网菜单提供的多个精确名称，仍要求主机行上有独立文字证据。
  const expectedModels = Array.isArray(expectedModel) ? expectedModel : [expectedModel];
  const gpuModel = uniqueModel(lines.filter(line => knownGpuLine.test(line) || expectedModels.some(model => sameModel(line, model))));
  const available = text.match(/(?:^|\n)\s*(\d+)\s*\/\s*(\d+)\s*(?:\n|$)/);
  // 可扩容容量：支持“1,024GB”“1.5TB”等写法；读不出时为 null（只在需要扩容时才因此排除主机）。
  const disk = text.match(/可扩容[：:]\s*(\d[\d,]*(?:\.\d+)?)\s*(GB|TB)/i);
  const driver = text.match(/驱动[：:]\s*([^\s]+)/);
  const cuda = text.match(/CUDA[：:]\s*(\d+(?:\.\d+)?)/i);
  const priceCell = cells.find(c => /[￥¥]\s*\d+(?:\.\d+)?\s*\/?\s*时/.test(c));
  const price = priceCell?.match(/[￥¥]\s*(\d+(?:\.\d+)?)/);
  // 主机号：优先取整格就是“…机”的单元格；地区与主机号写在同一格时取格内的“…机”。
  const numberCell = cells.find(c => /^\S+机$/.test(c.trim()))?.trim() || cells.map(c => c.match(/(?:^|\s)([\dA-Z]+机)(?=\s|$)/)?.[1]).find(Boolean) || '';
  return { id: raw.id, number: numberCell, region,
    gpuModel, available: available ? Number(available[1]) : null,
    total: available ? Number(available[2]) : null, expandableGB: disk ? Number(disk[1].replace(/,/g, '')) * (/^TB$/i.test(disk[2]) ? 1024 : 1) : null,
    driver: driver?.[1] || '', maxCuda: cuda?.[1] || '', price: price ? number(price[1]) : null,
    disabled: raw.disabled === true };
}
// 公开前端 index.7d7f696b.js 的“实例ID /名称”列：UUID 是独立的可复制 div，
// 名称另放在后续 span。按列与节点共同读取主键，备注中的同形字符串不参与身份匹配。
export function readInstanceRowElements(rows) {
  return rows.map(row => {
    const headers = [...(row.closest('.el-table')?.querySelectorAll('.el-table__header-wrapper th') || [])];
    const identityColumn = headers.findIndex(header => header.innerText.replace(/\s+/g, '') === '实例ID/名称');
    const cell = identityColumn >= 0 ? row.querySelectorAll('td')[identityColumn] : null;
    const candidates = [...(cell?.querySelectorAll('div') || [])].filter(node => node.style.cursor === 'pointer'
      && node.childElementCount === 0 && /^[a-z0-9]{8,24}-[a-z0-9]{6,24}$/i.test(node.innerText.trim()));
    return { text: row.innerText, instanceId: candidates.length === 1 ? candidates[0].innerText.trim() : '', identityColumn };
  });
}

export function parseInstanceRow(text, expectedModel = '', instanceId) {
  const candidates = [...new Set([...text.matchAll(/\b[a-z0-9]{8,24}-[a-z0-9]{6,24}\b/gi)].map(m => m[0]))];
  // 纯文本只在没有歧义时解析；生产页面必须传入从身份列读到的主键。
  const id = instanceId === undefined ? (candidates.length === 1 ? candidates[0] : '') : candidates.includes(instanceId) ? instanceId : '';
  if (!id) return null;
  const ids = [id];
  const gpuEvidence = new Map();
  for (const line of text.split(/\r?\n|\t/)) {
    for (const count of line.matchAll(/[×xX*]\s*(\d+)(?![\d.])/g)) {
      const prefix = line.slice(0, count.index).trim();
      // 未知系列只接受独立型号行。已知系列可兼容表格 innerText 的同行字段。
      const model = sameModel(prefix, expectedModel) ? prefix : prefix.match(knownGpuSuffix)?.[1]?.trim();
      if (model) gpuEvidence.set(gpuKey(model) + ':' + count[1], { model, count: Number(count[1]) });
    }
  }
  const gpu = gpuEvidence.size === 1 ? [...gpuEvidence.values()][0] : null;
  const copying = /数据盘\s*(?:复制|拷贝)[中进]/.test(text);
  // “无卡模式开机”是操作菜单文字；只有运行/开机状态旁的独立“无卡模式”才算无卡运行。
  const cardless = /(?:运行中|已开机|开机中)/.test(text) && (/(?:^|\n|\t)\s*无卡模式\s*(?=\n|\t|$)/.test(text)
    || /(?:运行中|已开机|开机中)[\s（(]*无卡模式(?!开机)/.test(text));
  const starting = /开机中/.test(text), shutting = /关机中/.test(text);
  return { id, ids, region: REGIONS.find(r => text.includes(r)) || '', gpuModel: gpu?.model || '',
    gpuCount: gpu?.count ?? null, hostNumber: text.match(/\b[\dA-Z]+机(?![一-龥])/)?.[0] || text.match(/[\dA-Z]+机(?![一-龥])/)?.[0] || '',
    stopped: /已关机/.test(text) && !starting && !shutting, running: /(?:运行中|已开机)/.test(text) && !cardless && !shutting && !starting,
    cardless, starting, gpuAvailable: /GPU\s*充足/.test(text) ? true : /GPU\s*不足|无空闲\s*GPU/.test(text) ? false : null,
    copyFailed: /数据盘[\s\S]{0,12}(?:复制|拷贝)[\s\S]{0,8}失败/.test(text),
    // 复制中优先：同一行既有“复制中”又有“复制完成后才能写入”之类的提示时，不算完成。
    copyComplete: !copying && /数据盘\s*(?:复制|拷贝)\s*(?:已)?(?:成功|完成)(?![后前时])/.test(text),
    failed: /(?:创建失败|开机失败|克隆失败)/.test(text),
    progress: copying ? '数据盘复制中' : /克隆中|创建中/.test(text) ? '系统盘克隆/创建中' : '',
    releaseDays: (() => { const m = text.match(/(\d+)\s*天[^\n]{0,24}后(?:释放|删除)/); return m ? Number(m[1]) : null; })(),
  };
}
export function parseQuoteText(text) {
  const hour = text.match(/配置费用\s*[：:]\s*[￥¥]\s*([\d.]+)\s*\/\s*时/);
  const daily = text.match(/日常费用\s*[：:]\s*[￥¥]\s*([\d.]+)\s*\/\s*日/);
  return { hourly: hour ? Number(hour[1]) : null, storageDaily: daily ? Number(daily[1]) : null };
}

