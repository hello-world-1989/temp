// Side effects of review decisions: optional export of published posts to a GitHub repo
// (a second place to read them, and a backup). Off unless configured. Failures are logged,
// never thrown. Review in Telegram is in telegram.js.

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
    enabled: { github: ghOn },

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
  };
}
