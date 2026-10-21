import { AuthGate } from "../components/auth";
import { Workspace } from "../components/workspace";
import { SessionProvider } from "../lib/session";

export function meta() {
  return [{ title: "Dispatch · Your workspace" }];
}

export default function Home() {
  return <SessionProvider><AuthGate><Workspace /></AuthGate></SessionProvider>;
}
