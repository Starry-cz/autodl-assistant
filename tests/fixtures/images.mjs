// 仅用于隔离测试的合成菜单，不是 AutoDL 当前目录或版本承诺。
export const SYNTHETIC_IMAGES = [
  ['PyTorch','2.1.0','3.10(ubuntu22.04)','12.1'],
  ['PyTorch','2.8.0','3.12(ubuntu22.04)','12.8'],
  ['PyTorch','2.8.0','3.12(ubuntu22.04)','13.0'],
  ['Miniconda','conda3','3.10(ubuntu22.04)','12.1'],
];
export async function syntheticImageOptions(prefix=[]) {
  const matches=SYNTHETIC_IMAGES.filter(parts=>prefix.every((part,i)=>parts[i]===part));
  return {prefix,level:prefix.length,options:[...new Set(matches.map(parts=>parts[prefix.length]))].filter(Boolean).map(label=>({label,disabled:false})),source:'隔离合成镜像菜单',checkedAt:Date.now()};
}
export async function selectSyntheticImage(page, parts=SYNTHETIC_IMAGES[0]) {
  await page.locator('#sync-images').click();
  for(const [i,id] of ['#image-framework','#image-version','#image-python','#image-cuda'].entries()) {
    await page.waitForFunction(([selector,value])=>{const select=document.querySelector(selector);return !select.disabled&&[...select.options].some(option=>option.value===value);},[id,parts[i]]);
    await page.locator(id).selectOption(parts[i]);
  }
}

