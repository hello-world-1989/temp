# 和谐词典

网址：`/dict`（今日一词）、`/dict/words`（词库）、`/dict/words/<id>`（词条）、`/dict/about`（关于）、`/dict/submit`（补充词条）。

记录中国社交平台（小红书、抖音、微博、B 站等）上因审查、限流或广告法而不能直接写的词，以及网友常用的替代写法。目的是记录网络语言现象，防止以后的人看不懂今天中国的文字和互联网。只记录语言现象，客观中立。

词库以本目录的 `words.json`（预置词条）为主；网友补充是辅助，审核方式和事件墙一样。

## 添加新词条

1. 编辑 `dict/words.json`，在数组里加一项：

   ```json
   {
     "id": "yimin",
     "word": "移民",
     "alternatives": ["润", "run", "跑路"],
     "category": "政治审查",
     "reason": "一两句说明为什么被限制。",
     "example": "一句用了替代写法的例句（可空）",
     "trivia": "一句有趣的背景（可空）",
     "featuredDate": "2026-11-01"
   }
   ```

   - `id`：小写字母、数字或 `-`，用在网址里，不能重复（一般用拼音）。
   - `category`：`平台限流` `广告法` `政治审查` `引流/联系方式` `健康医疗` `金钱交易` 之一。
   - `featuredDate`：可选。那一天的“今日一词”固定用这个词。
2. `cd new-site && npm run build`。构建会检查词条（重复、缺字段、分类不对会直接报错），生成
   `public/dict/words/<id>.html`（每个词条一个页面，有独立的标题和描述）、`public/assets/dict-data.js`
   和 `public/sitemap.xml`。
3. 提交并推送 `v2` 分支即部署。

今日一词：优先用 `featuredDate` 等于当天（北京时间）的词条；没有就用“1970-01-01 起的天数 % 词条数”。
只用预置词条计算，所有人同一天看到同一个词。注意：增删词条会改变以后（和以前）每天对应的词，想固定某天的词就写 `featuredDate`。

## 批量导入（爬取或整理的数据）

```bash
node scripts/dict-import.mjs 数据.json --dry-run    # 先看会改什么
node scripts/dict-import.mjs 数据.json
npm run build
```

输入是 JSON 数组，每项字段同上（`id` 可省，`alternatives` 也可以是用逗号或顿号隔开的字符串）。
已有的词只会合并新的替代写法、补上空着的例句和小知识；新词必须有 `word`、`alternatives`、`category`、`reason`。
爬虫、表格导出都可以先转成这个格式再导入。

把网友补充、已审核通过的词收进预置词库（之后可以在后台下架网上那条，避免重复）：

```bash
node scripts/dict-import.mjs --from-api https://end-gfw.com/api/board/dict
```

## 网友补充

- `/dict/submit` 匿名提交，防刷用和事件墙一样的工作量证明，不收集 IP 等任何信息。
- 存在事件墙服务（`board-server/`，表 `dict_words`），接口 `/api/board/dict`。
- 审核：事件墙后台 `/board-admin` 的“待审词条”，或 Telegram 审核群（✅ / ❌）。通过后出现在词库里，网址 `/dict/words/<编号>`。
- 投稿人用回执码在 `/board-status` 查进度或撤回。未通过、下架和撤回的内容 7 天后彻底删除。
- 服务端没更新时，词库照常显示预置词条，只是没有网友补充。

## 隐私

和谐词典页面不放广告、不接统计和第三方脚本（`public/_headers` 里有单独的 CSP），不下载外部字体（标题用系统自带的宋体 / Noto Serif SC）。
深浅色选择只存在浏览器的 localStorage。分享图片在浏览器里用 `public/assets/vendor/html-to-image.js` 生成，不上传。
