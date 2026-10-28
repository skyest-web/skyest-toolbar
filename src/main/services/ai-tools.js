// 宠物（AI 对话）能调的本机工具。目前只有一个，而且刻意是只读的：
// 「打开文件」那条口子不给模型——search:open 的 (listId, 序号) 一旦能被它自己拼出来，
// 就等于让它挑一个文件替你双击。要加工件就照 searchFilesTool 的形状再加一个，
// ai.js 里的循环不用动（它只认 name / schema / run）。
const MAX_ITEMS = 12;
const MAX_RESULT_CHARS = 3000;

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value}B` : `${value.toFixed(1)}${units[unit]}`;
}

function formatDate(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function searchFilesTool(everything) {
  return {
    name: 'search_files',
    label: (query) => `查了本机文件索引「${query}」`,
    schema: {
      type: 'function',
      function: {
        name: 'search_files',
        description:
          '按文件名关键字在本机全盘索引（Everything）里找文件或文件夹。只读：只能拿到名字和路径，打不开文件。' +
          '用户问「X 在哪」「有没有 X 这个文件」「帮我找一下 X」时用它。找不到就说找不到，别编路径。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '文件名里的关键字，可以是片段，例如 everything.exe' },
            limit: { type: 'integer', description: `最多返回几条，默认 ${MAX_ITEMS}，上限 ${MAX_ITEMS}`, minimum: 1, maximum: MAX_ITEMS }
          },
          required: ['query'],
          additionalProperties: false
        }
      }
    },
    async run(args) {
      const query = String(args?.query ?? '').trim().slice(0, 200);
      if (!query) return { text: '没给关键字，这次没查。', count: 0 };
      const cap = Math.min(MAX_ITEMS, Math.max(1, Number(args?.limit) || MAX_ITEMS));

      const result = await everything.search(query);
      if (!result.ok) return { text: `没查成：${result.message || 'Everything 没在跑，或者索引还没建好'}`, count: 0 };

      const items = (result.items || []).slice(0, cap);
      if (!items.length) return { text: `本机文件名里没有匹配「${query}」的东西。`, count: 0 };

      const lines = items.map((item, index) => {
        const kind = item.folder ? '文件夹' : formatSize(item.size) || '文件';
        const when = formatDate(item.modified);
        return `${index + 1}. ${item.name}｜${kind}${when ? `｜${when}` : ''}\n   ${item.path}`;
      });
      let text = `关键字「${query}」全盘命中 ${result.total} 条，给你前 ${items.length} 条：\n${lines.join('\n')}`;
      if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n…（结果太长，截断了）`;
      return { text, count: items.length };
    }
  };
}

function buildTools({ everything }) {
  if (!everything) return [];
  return [searchFilesTool(everything)];
}

module.exports = { buildTools, MAX_ITEMS };
