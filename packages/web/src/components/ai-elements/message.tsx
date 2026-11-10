import { memo, useEffect, useRef, useState, type ComponentProps } from 'react';
import { Streamdown } from 'streamdown';
import { createPortal } from 'react-dom';
import { Button } from '../ui/button';
export { Message, MessageContent } from '../ui/message';
type LinkModalProps = Parameters<NonNullable<NonNullable<ComponentProps<typeof Streamdown>['linkSafety']>['renderModal']>>[0];
function LinkModal({isOpen, onClose, onConfirm, url}: LinkModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    // Dismiss the software keyboard before the external-link confirmation opens.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    dialog.current?.showModal();
  }, [isOpen]);
  if (!isOpen) return null;
  return createPortal(<dialog ref={dialog} className="external-link-dialog" aria-labelledby="external-link-title" onCancel={onClose} onClose={onClose}>
    <h2 id="external-link-title">Open external link?</h2><p className="external-link-url">{url}</p>
    <div><Button variant="outline" onClick={() => {void navigator.clipboard.writeText(url).then(() => setCopied(true)).catch(() => setCopied(false));}}>{copied ? 'Copied' : 'Copy link'}</Button><Button onClick={() => {onConfirm(); onClose();}}>Open link</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
  </dialog>, document.body);
}
const linkSafety = { enabled: true, renderModal: (props: LinkModalProps) => <LinkModal {...props}/> };
// Agent output is mostly JSON with long strings: wrap lines, without numbers that misalign wrapped indentation.
export const MessageResponse = memo((props: ComponentProps<typeof Streamdown>) => <Streamdown linkSafety={linkSafety} lineNumbers={false} {...props}/>);
