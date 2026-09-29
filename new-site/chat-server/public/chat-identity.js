// The 加密聊天 identity (保险箱) for other pages of this site, such as 事件墙: they load this with
// import('/chat/assets/chat-identity.js') and keep working without it. 事件墙 posts stay
// anonymous: only the receipts are kept, inside the encrypted vault on this device (and in the
// 恢复口令 backup when that is on).
import { kvGet, kvPut } from './chat-crypto.js';
import { cleanContents, lockBox, openBox, pushRecovery, sessionKey, setSessionKey, unlockBox } from './chat-vault.js';

// -> { box, raw, data } when this tab has the vault unlocked; 'locked' | 'none' otherwise
async function openVault() {
  const box = await kvGet('vault').catch(() => null);
  if (!box) return 'none';
  const raw = sessionKey();
  if (!raw) return 'locked';
  try {
    return { box, raw, data: cleanContents(await unlockBox(raw, box)) };
  } catch {
    return 'locked';
  }
}

async function addReceipt(v, entry) {
  if (!v.data.receipts.some((r) => r.receipt === entry.receipt)) {
    v.data.receipts.unshift({ receipt: entry.receipt, kind: entry.kind === 'comment' ? 'comment' : 'post', title: String(entry.title || '').slice(0, 80), at: Date.now() });
  }
  await kvPut('vault', await lockBox(v.raw, v.data, v.box));
  if (v.data.recovery) await pushRecovery(v.data).catch(() => {}); // the local copy is saved either way
}

// -> 'saved' | 'locked' (needs the passphrase: unlockAndSave) | 'none' (no identity set up)
export async function saveReceipt(entry) {
  const v = await openVault();
  if (typeof v === 'string') return v;
  await addReceipt(v, entry);
  return 'saved';
}

// Throws Error('password') for a wrong passphrase
export async function unlockAndSave(pass, entry) {
  const box = await kvGet('vault');
  const { data, raw } = await openBox(pass, box);
  setSessionKey(raw); // this tab stays unlocked, as in 加密聊天
  await addReceipt({ box, raw, data: cleanContents(data) }, entry);
  return 'saved';
}

// The nickname from the identity, when this tab has it unlocked
export async function currentNick() {
  const v = await openVault();
  return typeof v === 'string' ? '' : v.data.nick;
}
