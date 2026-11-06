// 通用页面回归只读取合成发布信息；版本检查不访问 GitHub，也不干扰各页面原有的业务 mock。
export const offlineUpdateOptions = {
  fetchImpl: async () => new Response(JSON.stringify({
    tag_name: 'v0.0.0',
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/Starry-cz/autodl-assistant/releases/tag/v0.0.0',
    assets: [],
    body: '',
  }), { headers: { 'Content-Type': 'application/json' } }),
};
