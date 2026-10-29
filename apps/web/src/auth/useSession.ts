import { useSyncExternalStore } from "react";
import { session, SessionState } from "./session";

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, session.getState);
}
