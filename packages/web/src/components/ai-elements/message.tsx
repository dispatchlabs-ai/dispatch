import { memo, type ComponentProps } from 'react';
import { Streamdown } from 'streamdown';
export { Message, MessageContent } from '../ui/message';
// Agent output is mostly JSON with long strings: wrap lines, without numbers that misalign wrapped indentation.
export const MessageResponse = memo((props: ComponentProps<typeof Streamdown>) => <Streamdown lineNumbers={false} {...props}/>);
