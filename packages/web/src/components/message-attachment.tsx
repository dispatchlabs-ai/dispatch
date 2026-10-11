import { useState } from "react";
import { PatchAttachment } from "./patch-attachment";
import { ATTACHMENT_IMAGE_MAX_BYTES, type Attachment } from "../shared/contracts";

export function MessageAttachment({ attachment }: { attachment: Attachment }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  if (attachment.kind === "text" && /\.(patch|diff)$/i.test(attachment.name)) return <PatchAttachment attachment={attachment} />;
  const image = attachment.kind === "image";
  return <a className={`message-attachment${image ? " message-attachment-image" : ""}`} href={attachment.url} target="_blank" rel="noopener noreferrer">
    {image && !previewFailed ? <img src={attachment.url} alt="" loading="lazy" onError={() => setPreviewFailed(true)} /> : null}
    <span>{attachment.name}{attachment.kind === "file" ? " · Download only" : image && attachment.size > ATTACHMENT_IMAGE_MAX_BYTES ? " · Preview/download only; too large for agents" : ""}</span>
    <span className="sr-only"> (opens in a new tab)</span>
    {image && previewFailed ? <span role="status">Preview unavailable</span> : null}
  </a>;
}
