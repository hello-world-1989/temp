// Side effects of review decisions: optional export of published posts to a GitHub repo
// (a second place to read them, and a backup), and an optional Telegram ping to admins
// when the queue grows. Both are off unless configured. Failures are logged, never thrown.

const GH_API = 'https://api.github.com';

export function exportDoc(post, images, siteUrl) {
  return {
    id: post.id,
    title: post.title,
    category: post.category,
    place: post.place,
    happenedOn: post.happenedOn,
    publishedAt: post.publishedAt,
    url: `${siteUrl}/board/e/${post.id}`,
    body: post.body,
    images: images.map((im) => `${siteUrl}/api/board/img/${im.id}`),
  };
}

export function createPublisher(config, fetchImpl = globalThis.fetch) {
  const gh = config.github;
  const ghOn = Boolean(gh.token && gh.repo);
  const tg = config.telegram;

  async function ghRequest(method, path, body) {
    const res = await fetchImpl(`${GH_API}/repos/${gh.repo}/contents/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${gh.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'end-gfw-board',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }

  async function currentSha(path) {
    const res = await ghRequest('GET', `${path}?ref=${encodeURIComponent(gh.branch)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`github get ${res.status}`);
    return (await res.json()).sha;
  }

  const committer = { name: 'Git', email: 'git@example.com' };

  return {
    enabled: { github: ghOn, telegram: Boolean(tg.token && tg.chatId) },

    async published(post, images) {
      if (!ghOn) return;
      const path = `${gh.dir}/${post.id}.json`;
      try {
        const sha = await currentSha(path);
        const content = Buffer.from(JSON.stringify(exportDoc(post, images, config.siteUrl), null, 2) + '\n').toString('base64');
        const res = await ghRequest('PUT', path, { message: `board: ${post.id}`, content, branch: gh.branch, committer, author: committer, ...(sha ? { sha } : {}) });
        if (!res.ok) throw new Error(`github put ${res.status}`);
      } catch (err) {
        console.error('export failed', post.id, err.message);
      }
    },

    async unpublished(id) {
      if (!ghOn) return;
      const path = `${gh.dir}/${id}.json`;
      try {
        const sha = await currentSha(path);
        if (!sha) return;
        const res = await ghRequest('DELETE', path, { message: `board: remove ${id}`, sha, branch: gh.branch, committer, author: committer });
        if (!res.ok) throw new Error(`github delete ${res.status}`);
      } catch (err) {
        console.error('export removal failed', id, err.message);
      }
    },

    // Only counts go to Telegram, never the content of a submission
    async queued(kind, pendingCount) {
      if (!tg.token || !tg.chatId) return;
      try {
        await fetchImpl(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: tg.chatId, text: `事件墙：新的${kind === 'post' ? '投稿' : '评论'}待审核（共 ${pendingCount} 条）\n${config.siteUrl}/board-admin`, disable_web_page_preview: true }),
        });
      } catch (err) {
        console.error('notify failed', err.message);
      }
    },
  };
}
