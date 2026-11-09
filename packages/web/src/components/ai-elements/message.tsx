import { memo, type ComponentProps } from 'react';
import { Streamdown } from 'streamdown';
export { Message, MessageContent } from '../ui/message';
export const MessageResponse = memo((props: ComponentProps<typeof Streamdown>) => <Streamdown {...props}/>);
