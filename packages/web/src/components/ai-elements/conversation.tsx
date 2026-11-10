// Compatibility exports composed with the current official Chat pattern.
import type { ComponentProps } from 'react';
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerButton } from '../ui/message-scroller';
export function Conversation(props: ComponentProps<typeof MessageScroller>) { return <MessageScrollerProvider autoScroll><MessageScroller {...props}/></MessageScrollerProvider>; }
export function ConversationContent(props: ComponentProps<typeof MessageScrollerContent>) { return <MessageScrollerViewport><MessageScrollerContent {...props}/></MessageScrollerViewport>; }
export const ConversationScrollButton = MessageScrollerButton;
export function ConversationEmptyState({title, description}: {title: string; description: string}) { return <div className="empty-state"><div className="empty-mark">✳</div><h2>{title}</h2><p>{description}</p></div>; }
