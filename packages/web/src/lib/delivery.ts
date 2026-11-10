import type { AttachmentFile } from './contracts';
export interface Pending { chatId: string; text: string; draftText?: string; requestId: string; attachments?: AttachmentFile[] }
export interface DeliveryState { text: string; attachments: AttachmentFile[]; pending: Pending | null }
const storageKey = 'dispatch-web:outbox-key';
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('dispatch-web-delivery', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('draft');
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});

// sessionStorage survives reload, but browsers can copy it into another live tab.
// A lifetime Web Lock claims the record before any read/write. A copied tab gets
// its own record, including the original pending identity/bytes, never a resend.
const ownedKey = (async () => {
  if (!navigator.locks) throw new Error('Exclusive browser draft ownership is unavailable.');
  const original = sessionStorage.getItem(storageKey) ?? sessionStorage.getItem('agent-chat:outbox-key') ?? crypto.randomUUID();
  let candidate = original;
  for (;;) {
    const key = candidate;
    const claimed = await new Promise<boolean>((resolve, reject) => {
      void navigator.locks.request(`dispatch-web:outbox:${key}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) { resolve(false); return; }
        try {
          const db = await database;
          if (key !== original) {
            await new Promise<void>((done, failed) => {
              const tx = db.transaction('draft', 'readwrite'), store = tx.objectStore('draft');
              const source = store.get(original);
              source.onsuccess = () => { if (source.result !== undefined) store.put(source.result, key); };
              tx.oncomplete = () => done(); tx.onerror = () => failed(tx.error); tx.onabort = () => failed(tx.error);
            });
          }
          sessionStorage.setItem(storageKey, key);
          resolve(true);
        } catch (error) { reject(error); return; }
        // The browser releases this exclusive claim when the document goes away.
        await new Promise<void>(() => {});
      }).catch(reject);
    });
    if (claimed) return key;
    candidate = crypto.randomUUID();
  }
})();

// Local outbox only, never a conversation/transcript database. No count/byte cap.
export async function saveDelivery(value: DeliveryState) {
  const key = await ownedKey, db = await database;
  await new Promise<void>((resolve,reject) => { const tx=db.transaction('draft','readwrite');tx.objectStore('draft').put(value,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error); });
}
export async function loadDelivery(): Promise<DeliveryState | undefined> {
  const key = await ownedKey, db=await database;
  const value = await new Promise<DeliveryState | undefined>((resolve,reject)=>{const request=db.transaction('draft').objectStore('draft').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  if (value !== undefined) return value;
  // One-time browser outbox adoption when replacing Agent Chat at the same
  // origin. Never alter the legacy record, pending request identity or file bytes.
  const legacyKey = sessionStorage.getItem('agent-chat:outbox-key');
  if (!legacyKey) return undefined;
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('agent-chat-delivery', 1);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    if (!legacy.objectStoreNames.contains('draft')) return undefined;
    const imported = await new Promise<DeliveryState | undefined>((resolve, reject) => {
      const request = legacy.transaction('draft').objectStore('draft').get(legacyKey);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (imported !== undefined) await saveDelivery(imported);
    return imported;
  } finally { legacy.close(); }
}
