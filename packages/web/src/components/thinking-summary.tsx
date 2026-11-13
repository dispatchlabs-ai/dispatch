import { MessageResponse } from '@/components/ai-elements/message';

export function ThinkingSummary({ text }: { text: string }) {
  return <details className="thinking-summary" open>
    <summary>Thinking</summary>
    <MessageResponse>{text}</MessageResponse>
  </details>;
}
