import { fail } from './errors.mjs';
export const IMAGE_LEVELS = ['框架名称', '框架版本', 'Python版本', 'CUDA版本'];
export function normalizeImagePrefix(prefix = []) {
  if (!Array.isArray(prefix) || prefix.length > 3 || prefix.some(part => typeof part !== 'string' || !part.trim() || part.length > 150 || /[\/\x00-\x1f]/.test(part)))
    fail('IMAGE_PREFIX', '镜像前缀必须是最多三级的官方菜单路径');
  return prefix.map(part => part.trim());
}
export function imageLabel(text, level) {
  const label = String(text ?? '').trim();
  return (label.startsWith(IMAGE_LEVELS[level]) ? label.slice(IMAGE_LEVELS[level].length) : label).trim();
}
export function imageCuda(label) { return String(label ?? '').match(/^(?:CUDA\s*)?(1\d\.\d{1,2})$/i)?.[1] ?? null; }
export function exactImagePath(selected, expected) {
  const parts = String(selected).split('/').map(part => part.trim());
  return parts.length === expected.length && parts.every((part, i) => imageLabel(part, i) === imageLabel(expected[i], i));
}

