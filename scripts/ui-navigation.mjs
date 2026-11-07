// 冒烟测试沿用用户可见入口，在工作区和设置区之间切换导航。
export async function openAccountMenu(page) {
  if (!await page.locator('#account-menu').isVisible()) await page.locator('#account-entry').click();
  await page.locator('#account-menu').waitFor({ state: 'visible' });
}

export async function goView(page, name) {
  const button = page.locator('.nav-item[data-view="' + name + '"]');
  if (!await button.isVisible()) {
    if (['profile', 'settings', 'billing', 'updates'].includes(name)) {
      await openAccountMenu(page);
      await page.locator('#account-menu [data-open-view="profile"]').click();
      await page.locator('#settings-navigation').waitFor({ state: 'visible' });
    } else {
      await page.locator('#back-to-workspace').click();
      await page.locator('#workspace-navigation').waitFor({ state: 'visible' });
    }
  }
  await button.click();
  await page.locator('#' + name).waitFor({ state: 'visible' });
}
