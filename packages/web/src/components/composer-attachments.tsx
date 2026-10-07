import { Menu } from "@base-ui/react/menu";
import { FilePlus, FileText, ImagePlus, Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DraftAttachment } from "../lib/attachments";
import { IconButton, Spinner } from "./ui";

export interface AttachmentComposerProps {
  attachments: DraftAttachment[];
  onAddFiles: (files: File[]) => string | undefined;
  onRemoveAttachment: (id: string) => void;
  onRetryAttachment: (id: string) => void;
}

export function AttachmentPicker({ disabled, onAddFiles }: { disabled: boolean; onAddFiles: (files: File[]) => void }) {
  const files = useRef<HTMLInputElement>(null);
  const images = useRef<HTMLInputElement>(null);
  const select = (input: HTMLInputElement) => {
    onAddFiles(Array.from(input.files ?? []));
    input.value = "";
  };
  return <div className="attachment-picker">
    <input hidden type="file" multiple ref={files} disabled={disabled} onChange={event => select(event.currentTarget)} />
    <input hidden type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" ref={images} disabled={disabled} onChange={event => select(event.currentTarget)} />
    <Menu.Root>
      <Menu.Trigger render={<IconButton label="Add to prompt" disabled={disabled}><Plus size={20} /></IconButton>} />
      <Menu.Portal><Menu.Positioner className="menu-positioner" side="top" align="start" sideOffset={6} collisionPadding={12}>
        <Menu.Popup className="action-menu attachment-menu">
          <Menu.Item onClick={() => files.current?.click()}><FilePlus size={16} /> Add files</Menu.Item>
          <Menu.Item onClick={() => images.current?.click()}><ImagePlus size={16} /> Add images</Menu.Item>
          <p className="attachment-sharing-note">Uploads are shared with conversation members immediately and retained even if removed from your draft.</p>
        </Menu.Popup>
      </Menu.Positioner></Menu.Portal>
    </Menu.Root>
  </div>;
}

function DraftPreview({ item }: { item: DraftAttachment }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(item.file.type)) return;
    const next = URL.createObjectURL(item.file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [item.file]);
  const preview = item.attachment ? item.attachment.kind === "image" ? item.attachment.url : undefined : url;
  return preview ? <img src={preview} alt="" /> : <FileText aria-hidden="true" size={24} />;
}

export function DraftAttachments({ attachments, disabled, onRemoveAttachment, onRetryAttachment }: Pick<AttachmentComposerProps, "attachments" | "onRemoveAttachment" | "onRetryAttachment"> & { disabled: boolean }) {
  if (!attachments.length) return null;
  return <div className="draft-attachments" aria-label="Prompt attachments">{attachments.map(item => <div className="draft-attachment" key={item.id}>
    <div className="attachment-thumbnail"><DraftPreview item={item} /></div>
    <div className="attachment-copy"><span title={item.file.name}>{item.file.name}</span><small>{item.error ? item.error : !item.attachment ? <Spinner label="Uploading" /> : item.attachment.kind === "file" ? "Download only · not readable by agents" : `${Math.ceil(item.file.size / 1024)} KB`}</small></div>
    {item.error ? <IconButton label={`Retry uploading ${item.file.name}`} disabled={disabled} onClick={() => onRetryAttachment(item.id)}><RotateCcw size={16} /></IconButton> : null}
    <IconButton label={`Remove ${item.file.name} from draft`} disabled={disabled} onClick={() => onRemoveAttachment(item.id)}><X size={16} /></IconButton>
  </div>)}</div>;
}
