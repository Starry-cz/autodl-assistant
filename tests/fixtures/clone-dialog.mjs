// 本地合成的 AutoDL 实例列表“更多”菜单与“克隆实例”对话框，仅供隔离页面测试。
// 结构与文字按 2026-10-29 读取的 AutoDL 公开前端代码复现：克隆页地址的参数与真实对话框相同，
// 不勾选数据盘时 copy_data_disk 为空字符串。菜单中其余操作被点击时会请求 /fixture/danger 记录下来，测试要求一次都没有。
const MENU = ['无卡模式开机', '保存镜像', '升降配置', '扩容数据盘', '缩容数据盘', '转包年包月', '克隆实例', '跨实例拷贝数据', '修改SSH密码', '重置系统', '释放实例', '重新创建'];
export function cloneDialogHtml(source, { cloneDisabled = false, notice = true, othersSelected = false, continueDisabled = false,
  useAddress = false, imageCuda = '12.1', expandBytes = 107374182400, menuText = '克隆实例' } = {}) {
  const items = MENU.map(label => label === '克隆实例'
    ? '<li class="menu-item clone' + (cloneDisabled ? ' is-disabled" aria-disabled="true' : '') + '">' + menuText + '</li>'
    : '<li class="menu-item danger" data-act="' + label + '">' + label + '</li>').join('');
  const query = 'region=beijing-B&id=' + encodeURIComponent(source.id) + '&name=synthetic&copy_data_disk="+(copy?"1":"")+"&expand_size=' + expandBytes
    + '&use_address=' + (useAddress ? '1' : '') + '&base_image_uuid=synthetic-image&private_image_uuid=&reproduction_uuid=&chip_corp=nvidia&cpu_arch=x86&image_cuda=' + imageCuda;
  return '<!doctype html><meta charset="utf-8"><body>'
    + '<div class="el-table instance-table"><div class="el-table__header-wrapper"><table><thead><tr><th>实例ID/名称</th><th>地区</th><th>配置</th><th>状态</th><th>操作</th></tr></thead></table></div>'
    + '<div class="el-table__body-wrapper"><table><tbody><tr><td><div style="cursor:pointer">' + source.id + '</div><div><span>合成实例</span></div></td><td>' + source.region + '</td><td>' + source.gpuModel + ' × ' + source.gpuCount + '卡</td><td>已关机</td>'
    + '<td><button id="start">开机</button><button id="more">更多</button></td></tr></tbody></table></div></div>'
    + '<ul id="menu" hidden>' + items + '</ul>'
    + '<div role="dialog" hidden><h2>克隆实例</h2>' + (notice ? '<div class="el-alert">克隆后源实例不受影响，不会释放也不会清理数据</div>' : '')
    + '<label class="el-radio-button' + (othersSelected ? '' : ' is-active') + '">克隆给自己</label><label class="el-radio-button' + (othersSelected ? ' is-active' : '') + '">克隆给他人</label>'
    + '<label class="el-checkbox is-checked is-disabled"><input type="checkbox" checked disabled>系统盘</label><label class="el-checkbox"><input type="checkbox">数据盘</label>'
    + '<button id="cancel">取消</button><button id="continue"' + (continueDisabled ? ' disabled' : '') + '>继续</button></div>'
    + '<script>const $=s=>document.querySelector(s);'
    + 'document.querySelectorAll(".danger,#start").forEach(el=>el.onclick=()=>fetch("/fixture/danger?act="+encodeURIComponent(el.dataset.act||el.textContent)));'
    + '$("#more").onclick=()=>{$("#menu").hidden=false;};'
    + '$(".clone").onclick=()=>{if($(".clone").classList.contains("is-disabled"))return;$("#menu").hidden=true;$("[role=dialog]").hidden=false;};'
    + '$("#cancel").onclick=()=>{$("[role=dialog]").hidden=true;};'
    + '$("#continue").onclick=()=>{const copy=document.querySelectorAll("[role=dialog] input")[1].checked;location.href="/cloneInstance?' + query + '";};'
    + '</script>';
}

