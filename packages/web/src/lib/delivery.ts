import type { AttachmentFile } from './contracts';
export interface Pending { chatId: string; text: string; requestId: string; attachments?: AttachmentFile[] }
export interface DeliveryState { text: string; attachments: AttachmentFile[]; pending: Pending | null }
const tabKey = sessionStorage.getItem('dispatch-web:outbox-key') ?? crypto.randomUUID();
sessionStorage.setItem('dispatch-web:outbox-key', tabKey);
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('dispatch-web-delivery', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('draft');
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
// Local outbox only, never a conversation/transcript database. No count/byte cap.
export async function saveDelivery(value: DeliveryState) {
  const db = await database;
  await new Promise<void>((resolve,reject) => { const tx=db.transaction('draft','readwrite');tx.objectStore('draft').put(value,tabKey);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error); });
}
export async function loadDelivery(): Promise<DeliveryState | undefined> {
  const db=await database;
  return new Promise((resolve,reject)=>{const request=db.transaction('draft').objectStore('draft').get(tabKey);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
}
