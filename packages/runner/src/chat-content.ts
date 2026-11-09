import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

export type AttachmentFile = { name: string; mimeType: string; data: string };
export class ContentError extends Error { readonly status = 409; }
// Scan once with constant stack space. Grouped base64 regexes overflow V8's
// regexp stack for ordinary multi-megabyte uploads; there is no size ceiling.
function validBase64(data: string) {
  if (data.length % 4 !== 0) return false;
  const end = data.length - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  for (let i = 0; i < end; i++) {
    const code = data.charCodeAt(i);
    if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47)) return false;
  }
  return true;
}
// Browser bytes only: never interpret a filename as a host path or URL.
export function prepareContent(text: string, files: AttachmentFile[] = []) {
  if (typeof text !== "string" || !Array.isArray(files)) throw new ContentError("Provide text and an attachment array.");
  const blocks: (TextContent | ImageContent)[] = text.trim() ? [{type: 'text', text}] : [];
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || !file.name || typeof file.mimeType !== 'string' || typeof file.data !== 'string' || !validBase64(file.data)) throw new ContentError('Invalid attachment bytes. Select the file again.');
    const bytes = Buffer.from(file.data, 'base64');
    if (file.mimeType.startsWith('image/')) {
      const valid = file.mimeType === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : file.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : file.mimeType === 'image/webp' ? bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' : false;
      if (!valid) throw new ContentError('Supported images: PNG, JPEG and WebP with matching file bytes.');
      blocks.push({type: 'text', text: `Attached image: ${file.name}`}, {type:'image', data:file.data, mimeType:file.mimeType});
    } else {
      if (!(file.mimeType.startsWith('text/') || ['application/json','application/xml','application/javascript','application/yaml','application/x-yaml'].includes(file.mimeType) || !file.mimeType && /\.(txt|md|csv|json|ya?ml|xml|log|ts|js|py)$/i.test(file.name))) throw new ContentError('Unsupported document. Select a UTF-8 text, Markdown, CSV, JSON or source file; PDF/Office/binary documents are not supported by this native input.');
      let decoded: string; try { decoded = new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { throw new ContentError('Documents must contain valid UTF-8 text.'); }
      if (decoded.includes('\0')) throw new ContentError('Binary documents are unsupported. Select UTF-8 text.');
      blocks.push({type:'text',text:`Attached document: ${file.name}\n\n${decoded}`});
    }
  }
  if (!blocks.length) throw new ContentError('Provide text or an attachment.');
  return files.length ? blocks : text;
}
