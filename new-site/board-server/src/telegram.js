// 事件墙 review in Telegram: the bot sends each new submission to the reviewers' chat with
// 通过 / 拒绝 buttons and applies the decision exactly as the web review page does.
//
// Privacy:
// - Only what the author typed goes to Telegram. The service never has the visitor's IP, device
//   or account, so there is none to send; images are the server's re-encoded copies (no EXIF,
//   no GPS, no camera data).
// - Messages are sent with protect_content (no forwarding, copying or saving) and the photos
//   as spoilers. The bot token and chat id are never logged.
// - Once a submission is decided (here, on the web page, or withdrawn by its author) its
//   content leaves the chat: photos and prompts are deleted and the text is replaced by a
//   one-line status. A published post keeps its title and link (both public by then).
// - Only chat TG_CHAT_ID is served and only the users in TG_ADMINS may decide; everyone
//   else is ignored. Long polling: nothing is exposed to the internet for the bot.
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const API = 'https://api.telegram.org';
const BODY_MAX = 3000; // a Telegram message holds 4096 characters
export const REASONS = ['无法核实', '信息不足，请写清时间、地点和经过', '与事件墙主题无关', '含有他人隐私信息', '重复投稿', '广告或垃圾信息'];

const ID = '[A-Za-z0-9]{8,32}';
let blank; // grey square that replaces a photo Telegram no longer lets the bot delete (48 h)
const blankPng = async () => (blank ??= await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888' } }).png().toBuffer());
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function postText(p, siteUrl) {
  const facts = [p.category, p.place, p.happenedOn].filter(Boolean).join(' · ');
  const body = [...p.body].length > BODY_MAX ? `${[...p.body].slice(0, BODY_MAX).join('')}…\n（正文较长，全文见网页后台）` : p.body;
  const head = [`📝 新投稿待审核  编号 ${p.id}`, `标题：${p.title}`, facts, p.images.length ? `图片：${p.images.length} 张（见上方）` : ''];
  return [...head.filter(Boolean), '', body, '', `后台：${siteUrl}/board-admin`].join('\n');
}

export function commentText(c, siteUrl) {
  return [
    `💬 新评论待审核  编号 ${c.id}`,
    `事件：${c.postTitle}  ${siteUrl}/board/e/${c.postId}`,
    c.nickname ? `昵称：${c.nickname}` : '昵称：（匿名）',
    '',
    c.body,
  ].join('\n');
}

// Text the message is reduced to once decided: no content of anything that is not public
export function doneText(kind, id, { status, by, title, reason }, siteUrl) {
  const who = by ? `（${by}）` : '';
  if (kind === 'comment') {
    return { published: `✅ 评论已通过${who}  编号 ${id}`, rejected: `❌ 评论已拒绝${who}  编号 ${id}`, removed: `🗑 评论已删除${who}  编号 ${id}`, withdrawn: `↩️ 评论已被作者撤回  编号 ${id}` }[status] || `评论 ${id}：${status}`;
  }
  if (status === 'published') return `✅ 已通过${who}  编号 ${id}\n${title || ''}\n${siteUrl}/board/e/${id}`;
  if (status === 'rejected') return `❌ 已拒绝${who}  编号 ${id}${reason ? `\n原因：${reason}` : ''}`;
  if (status === 'removed') return `🗑 已删除${who}  编号 ${id}`;
  if (status === 'withdrawn') return `↩️ 投稿已被作者撤回  编号 ${id}`;
  return `投稿 ${id}：${status}`;
}

const postKeys = (id) => ({ inline_keyboard: [[{ text: '✅ 通过', callback_data: `p:${id}:a` }, { text: '❌ 拒绝…', callback_data: `p:${id}:r` }]] });
const reasonKeys = (id) => ({
  inline_keyboard: [
    ...REASONS.map((r, i) => [{ text: r, callback_data: `p:${id}:r${i}` }]),
    [{ text: '✍️ 自己写原因', callback_data: `p:${id}:rc` }, { text: '不写原因', callback_data: `p:${id}:rn` }],
    [{ text: '↩️ 返回', callback_data: `p:${id}:b` }],
  ],
});
const commentKeys = (id) => ({ inline_keyboard: [[{ text: '✅ 通过', callback_data: `c:${id}:a` }, { text: '❌ 拒绝', callback_data: `c:${id}:x` }]] });

// review: the object from createApp(...).review
export function createTelegram({ config, db, review, fetchImpl = globalThis.fetch, log = console }) {
  const tg = config.telegram || {};
  const enabled = Boolean(tg.token && tg.chatId && tg.admins?.size);
  const chat = String(tg.chatId || '');
  const siteUrl = config.siteUrl;
  let me = null;
  let stopped = false;
  const ctrl = new AbortController();

  async function call(method, body, timeoutMs = 20_000) {
    const form = body instanceof FormData;
    const res = await fetchImpl(`${API}/bot${tg.token}/${method}`, {
      method: 'POST',
      headers: form ? undefined : { 'Content-Type': 'application/json' },
      body: form ? body : JSON.stringify(body),
      signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const data = await res.json().catch(() => ({}));
    // Error text from Telegram only (the request URL carries the token and is never printed)
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description || res.status}`);
    return data.result;
  }

  const remember = (target, ids, main = false) =>
    ids.length && db.query('insert into tg_messages (chat_id, message_id, target, main) select $1, unnest($2::bigint[]), $3, $4 on conflict do nothing', [chat, ids, target, main]);

  async function sendPhotos(p) {
    const images = p.images.slice(0, 10);
    const form = new FormData();
    form.set('chat_id', chat);
    form.set('protect_content', 'true');
    form.set('disable_notification', 'true');
    const media = [];
    for (const [i, im] of images.entries()) {
      const data = await readFile(review.imageFile(im.id));
      form.set(`f${i}`, new Blob([data], { type: im.type }), `${i + 1}.${MIME_EXT[im.type] || 'jpg'}`);
      media.push({ type: 'photo', media: `attach://f${i}`, has_spoiler: true });
    }
    if (media.length === 1) {
      form.set('photo', form.get('f0'), `1.${MIME_EXT[images[0].type] || 'jpg'}`);
      form.delete('f0');
      form.set('has_spoiler', 'true');
      return [(await call('sendPhoto', form, 60_000)).message_id];
    }
    form.set('media', JSON.stringify(media));
    return (await call('sendMediaGroup', form, 120_000)).map((m) => m.message_id);
  }

  async function sendPost(id) {
    const p = await review.getPost(id);
    if (!p || p.status !== 'pending') return;
    const target = `post:${id}`;
    let photosFailed = false;
    if (p.images.length) {
      try {
        await remember(target, await sendPhotos(p));
      } catch (err) {
        photosFailed = true;
        log.error('telegram photos failed', id, err.message);
      }
    }
    const text = postText(p, siteUrl) + (photosFailed ? '\n（图片没能发到 Telegram，请在网页后台查看）' : '');
    const m = await call('sendMessage', { chat_id: chat, text, protect_content: true, link_preview_options: { is_disabled: true }, reply_markup: postKeys(id) });
    await remember(target, [m.message_id], true);
    // Decided or withdrawn while this was being sent: clear it right away
    const now = await review.getPost(id);
    if (!now || now.status !== 'pending') await changed('post', id, now ? { status: now.status, title: now.title, reason: now.rejectReason } : { status: 'withdrawn' });
  }

  async function sendComment(id) {
    const c = await review.getComment(id);
    if (!c || c.status !== 'pending') return;
    const m = await call('sendMessage', { chat_id: chat, text: commentText(c, siteUrl), protect_content: true, link_preview_options: { is_disabled: true }, reply_markup: commentKeys(id) });
    await remember(`comment:${id}`, [m.message_id], true);
    const now = await review.getComment(id);
    if (!now || now.status !== 'pending') await changed('comment', id, { status: now ? now.status : 'withdrawn' });
  }

  // Take a submission's content out of the chat; the main message keeps a one-line status
  async function changed(kind, id, info) {
    if (!enabled) return;
    const target = `${kind}:${id}`;
    const { rows } = await db.query('delete from tg_messages where target = $1 returning chat_id, message_id, main', [target]);
    for (const r of rows) {
      const ref = { chat_id: String(r.chat_id), message_id: Number(r.message_id) };
      if (r.main) {
        // Editing works at any age; if it fails, fall back to deleting
        await call('editMessageText', { ...ref, text: doneText(kind, id, info, siteUrl), link_preview_options: { is_disabled: true } })
          .catch(() => call('deleteMessage', ref))
          .catch((err) => log.error('telegram clear failed', target, err.message));
      } else {
        await call('deleteMessage', ref)
          .catch(async () => {
            const form = new FormData();
            form.set('chat_id', ref.chat_id);
            form.set('message_id', String(ref.message_id));
            form.set('media', JSON.stringify({ type: 'photo', media: 'attach://blank' }));
            form.set('blank', new Blob([await blankPng()], { type: 'image/png' }), 'blank.png');
            return call('editMessageMedia', form, 60_000);
          })
          .catch((err) => log.error('telegram delete failed', target, err.message));
      }
    }
  }

  // Posted by the app when something enters the queue
  async function queued(kind, _count, id) {
    if (!enabled || !id) return;
    try {
      await (kind === 'post' ? sendPost(id) : sendComment(id));
    } catch (err) {
      log.error('telegram notify failed', kind, id, err.message);
    }
  }

  // Everything pending that has no message in the chat yet (or all of it, when asked again)
  async function sendPending({ again = false } = {}) {
    const { posts, comments } = await review.pending(20);
    for (const [kind, ids] of [['post', posts], ['comment', comments]]) {
      for (const id of ids) {
        const target = `${kind}:${id}`;
        if (again) {
          const { rows } = await db.query('delete from tg_messages where target = $1 returning chat_id, message_id', [target]);
          for (const r of rows) await call('deleteMessage', { chat_id: String(r.chat_id), message_id: Number(r.message_id) }).catch(() => {});
        } else if ((await db.query('select 1 from tg_messages where target = $1 limit 1', [target])).rowCount) {
          continue;
        }
        await queued(kind, 0, id);
      }
    }
    return posts.length + comments.length;
  }

  const adminOf = (from) => (from && !from.is_bot ? tg.admins.get(String(from.id)) : undefined);
  const inChat = (c) => c && String(c.id) === chat;
  const answer = (q, text = '', alert = false) => call('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: alert }).catch(() => {});

  async function onCallback(q) {
    const name = adminOf(q.from);
    if (!name || !inChat(q.message?.chat)) return answer(q, '没有审核权限', true);
    const m = new RegExp(`^([pc]):(${ID}):(\\w+)$`).exec(q.data || '');
    if (!m) return answer(q);
    const [, k, id, act] = m;
    const admin = `tg:${name}`;
    const ref = { chat_id: chat, message_id: q.message.message_id };
    try {
      if (k === 'c') {
        const c = await review.getComment(id);
        if (!c || c.status !== 'pending') {
          await changed('comment', id, { status: c ? c.status : 'withdrawn' });
          return answer(q, '这条评论已经处理过了');
        }
        await review.comment(id, act === 'a' ? 'approve' : 'reject', admin);
        return answer(q, act === 'a' ? '已通过' : '已拒绝');
      }
      const p = await review.getPost(id);
      if (!p || p.status !== 'pending') {
        await changed('post', id, p ? { status: p.status, title: p.title, reason: p.rejectReason } : { status: 'withdrawn' });
        return answer(q, '这条投稿已经处理过了');
      }
      if (act === 'a') {
        await review.post(id, { action: 'approve' }, admin);
        return answer(q, '已通过并发布');
      }
      if (act === 'r' || act === 'b') {
        await call('editMessageReplyMarkup', { ...ref, reply_markup: act === 'r' ? reasonKeys(id) : postKeys(id) });
        return answer(q);
      }
      if (act === 'rc') {
        const prompt = await call('sendMessage', {
          chat_id: chat,
          text: `请回复这条消息，写下拒绝原因（最多 200 字，投稿人凭回执码能看到）。\n拒绝编号 ${id}`,
          protect_content: true,
          reply_parameters: { message_id: q.message.message_id, allow_sending_without_reply: true },
          reply_markup: { force_reply: true, selective: true, input_field_placeholder: '拒绝原因' },
        });
        await remember(`post:${id}`, [prompt.message_id]);
        return answer(q);
      }
      const r = /^r(\d)$/.exec(act);
      if (act === 'rn' || (r && REASONS[Number(r[1])])) {
        await review.post(id, { action: 'reject', reason: act === 'rn' ? '' : REASONS[Number(r[1])] }, admin);
        return answer(q, '已拒绝');
      }
      return answer(q);
    } catch (err) {
      if (err.status) return answer(q, err.message, true);
      log.error('telegram action failed', k, id, err.message);
      return answer(q, '出错了，请稍后再试或到网页后台处理', true);
    }
  }

  async function onMessage(msg) {
    const text = String(msg.text || '').trim();
    const cmd = /^\/(\w+)(@\w+)?/.exec(text);
    // Tells a person their own Telegram id (for TG_ADMINS), in a private chat only
    if (cmd && cmd[1] === 'id' && msg.chat?.type === 'private') {
      return call('sendMessage', { chat_id: msg.chat.id, text: `你的 Telegram 用户 ID：${msg.from?.id}` }).catch(() => {});
    }
    if (!inChat(msg.chat)) return;
    const name = adminOf(msg.from);
    if (!name) return;
    if (cmd && (cmd[1] === 'pending' || cmd[1] === 'start' || cmd[1] === 'help')) {
      if (cmd[1] !== 'pending') {
        await call('sendMessage', { chat_id: chat, text: '事件墙审核：新投稿和评论会自动发到这里。\n/pending 重新发送所有待审核的内容' });
        return;
      }
      const n = await sendPending({ again: true });
      if (!n) await call('sendMessage', { chat_id: chat, text: '没有待审核的内容' });
      return;
    }
    // Answer to the "write a reason" prompt
    const to = msg.reply_to_message;
    const m = to && me && to.from?.id === me.id && new RegExp(`拒绝编号 (${ID})$`).exec(to.text || '');
    if (!m || !text) return;
    const id = m[1];
    const done = () => call('deleteMessage', { chat_id: chat, message_id: msg.message_id }).catch(() => {});
    try {
      const p = await review.getPost(id);
      if (!p || p.status !== 'pending') {
        await done();
        return changed('post', id, p ? { status: p.status, title: p.title, reason: p.rejectReason } : { status: 'withdrawn' });
      }
      await review.post(id, { action: 'reject', reason: text }, `tg:${name}`);
      await done();
    } catch (err) {
      await call('sendMessage', { chat_id: chat, text: `没能拒绝：${err.status ? err.message : '出错了，请到网页后台处理'}`, reply_parameters: { message_id: msg.message_id } }).catch(() => {});
    }
  }

  async function onUpdate(u) {
    if (u.callback_query) return onCallback(u.callback_query);
    if (u.message) return onMessage(u.message);
  }

  async function start() {
    if (!enabled) return;
    let offset = 0;
    let wait = 1000;
    while (!stopped) {
      try {
        if (!me) {
          await call('deleteWebhook', {}); // getUpdates does not work while a webhook is set
          me = await call('getMe', {});
          await call('setMyCommands', { commands: [{ command: 'pending', description: '重新发送所有待审核的内容' }, { command: 'id', description: '显示我的 Telegram 用户 ID' }] }).catch(() => {});
          await sendPending();
        }
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65_000);
        for (const u of updates) {
          offset = u.update_id + 1;
          await onUpdate(u).catch((err) => log.error('telegram update failed', err.message));
        }
        wait = 1000;
      } catch (err) {
        if (stopped) break;
        log.error('telegram polling failed', err.message);
        await new Promise((r) => setTimeout(r, wait).unref());
        wait = Math.min(wait * 2, 60_000);
      }
    }
  }

  return {
    enabled,
    queued,
    changed: (kind, id, info) => changed(kind, id, info).catch((err) => log.error('telegram update failed', kind, id, err.message)),
    start,
    stop() {
      stopped = true;
      ctrl.abort();
    },
    // for tests
    onUpdate,
    sendPending,
  };
}
