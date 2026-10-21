// Shared wire constants; importing the workload client never imports the server credential store.
export const identityBody = "Action=GetCallerIdentity&Version=2011-06-15";
export const audienceHeader = "x-dispatch-gateway-audience";
export const identityHost = "sts.us-east-1.amazonaws.com";
