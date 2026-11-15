import { createBrowserRouter } from "react-router";
import { configureApi } from "@/lib/api";
import { resetSession } from "@/lib/query";
import { routes } from "./routes";

export const router = createBrowserRouter(routes);

// A 401 anywhere sends the user to the login screen without a page reload.
configureApi({
  currentAddress: () => `${router.state.location.pathname}${router.state.location.search}`,
  onUnauthorized: (loginAddress) => {
    if (router.state.location.pathname === "/login") return;
    resetSession(null);
    void router.navigate(loginAddress, { replace: true });
  },
});
