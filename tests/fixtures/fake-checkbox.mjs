// 内存中的 Element 风格复选框替身，供单元测试驱动真实的 readCheckboxes/setCheckbox 逻辑；不启动浏览器。
// onClick 可模拟延迟生效、页面规则或撤销；styled 与 checked 分开以模拟“原生勾选与组件样式不一致”。
export function fakeCheckbox(name, { checked = false, disabled = false, styled, element = true, onClick } = {}) {
  const box = { name, checked, styled: styled ?? checked, disabled, clicks: 0 };
  box.set = value => { box.checked = value; box.styled = value; };
  const input = { get checked() { return box.checked; }, get disabled() { return box.disabled; } };
  const wrap = { classList: { contains: c => c === 'is-checked' && box.styled } };
  box.node = {
    get innerText() { return box.name; },
    querySelector: selector => selector === 'input[type="checkbox"]' ? input : selector === '.el-checkbox__input' && element ? wrap : null,
    classList: { contains: c => (c === 'is-checked' && element && box.styled) || (c === 'is-disabled' && box.disabled) },
  };
  box.click = async () => {
    if (box.disabled) return;
    box.clicks++;
    if (onClick) await onClick(box); else box.set(!box.checked);
  };
  return box;
}
export function fakeLabels(boxes) {
  const list = () => boxes.filter(Boolean);
  return {
    count: async () => list().length,
    evaluateAll: async (fn, arg) => fn(list().map(box => box.node), arg),
    click: async () => { if (list().length !== 1) throw Error('synthetic strict mode violation'); await list()[0].click(); },
    elementHandles: async () => list().map(box => ({ innerText: async () => box.name, click: () => box.click(), dispose: async () => {} })),
  };
}

