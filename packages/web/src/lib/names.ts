/** Installation-qualified IDs are `installation~agent`; display the agent. */
export const agentName = (id: string) => id.includes('~') ? id.split('~').slice(1).join('~') : id;
export const installationName = (id: string) => id.includes('~') ? id.split('~')[0] : 'native';
