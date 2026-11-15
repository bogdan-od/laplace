import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api, describeError } from "./api";
import { meQuery, resetSession } from "./query";

/** data: Me when logged in, null when not, undefined while loading. */
export function useMe() {
  return useQuery(meQuery());
}

/** Navigation state that tells the login screen the user left on purpose (so it does not bounce back). */
export const LOGGED_OUT_STATE = { loggedOut: true } as const;

export function isLoggedOutState(state: unknown): boolean {
  return typeof state === "object" && state !== null && "loggedOut" in state && state.loggedOut === true;
}

/**
 * Logs out and opens `to`. The order matters: first leave the signed-in pages, then forget the user;
 * the other way round the signed-in layout would add its own `?next=` to the login address.
 */
export function useLogout(to = "/login"): { logout: () => Promise<void>; pending: boolean } {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const logout = async () => {
    setPending(true);
    try {
      await api("POST /api/auth/logout", { redirectOn401: false });
      await navigate(to, { replace: true, state: LOGGED_OUT_STATE });
      resetSession(null);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setPending(false);
    }
  };
  return { logout, pending };
}
