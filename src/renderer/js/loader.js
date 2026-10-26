TB.loader = {
  // 启动顺序：先问主进程要组件清单，把每个脚本注入页面（它们各自 TB.register 自己），再启动外壳。
  // 加新组件只要往 src/renderer/js/components/ 放一个 .js，不用改 index.html。
  loadScript(src) {
    return new Promise((resolve, reject) => {
      const node = document.createElement('script');
      node.src = src;
      node.onload = () => resolve(src);
      node.onerror = () => reject(new Error(`加载失败：${src}`));
      document.head.appendChild(node);
    });
  },

  async boot() {
    let files = [];
    try {
      files = await TB.api.components.list();
    } catch (err) {
      console.warn('[components] 取清单失败：', err.message);
    }
    for (const file of files) {
      await this.loadScript(`js/components/${file}`).catch((err) => console.warn('[components]', err.message));
    }
    TB.app.boot();
  }
};

window.addEventListener('DOMContentLoaded', () => TB.loader.boot());
