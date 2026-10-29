import { useEffect } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { z } from "zod";
import { session } from "./auth/session";
import { useSession } from "./auth/useSession";
import { Button } from "./components/Button";
import { AdminPage } from "./features/admin/AdminPage";
import { LoginPage } from "./features/auth/LoginPage";
import { TreePage } from "./features/tree/TreePage";

function Layout() {
  const { status, claims } = useSession();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (status === "anonymous" && pathname !== "/login") {
      void navigate({ to: "/login" });
    }
  }, [status, pathname, navigate]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <span className="font-semibold text-gray-900">DocBridge</span>
            {status === "authenticated" && (
              <nav className="flex items-center gap-4 text-sm">
                <Link
                  to="/"
                  className="text-gray-900 hover:text-blue-600"
                  activeProps={{ className: "font-medium text-blue-600" }}
                >
                  Destinations
                </Link>
                {claims?.admin && (
                  <Link
                    to="/admin"
                    className="text-gray-900 hover:text-blue-600"
                    activeProps={{ className: "font-medium text-blue-600" }}
                  >
                    Admin
                  </Link>
                )}
              </nav>
            )}
          </div>
          {status === "authenticated" && claims && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-500">{claims.name}</span>
              <Button variant="secondary" onClick={() => void session.logout()}>
                Logout
              </Button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}

async function requireAuthentication(locationHref: string) {
  await session.ready();
  if (session.getState().status !== "authenticated") {
    throw redirect({
      to: "/login",
      search: { redirect: locationHref },
    });
  }
}

const rootRoute = createRootRoute({ component: Layout });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>) =>
    z.object({ redirect: z.string().optional() }).parse(search),
  beforeLoad: async () => {
    await session.ready();
    if (session.getState().status === "authenticated") {
      throw redirect({ to: "/" });
    }
  },
  component: LoginPage,
});

const treeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: ({ location }) => requireAuthentication(location.href),
  component: TreePage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  beforeLoad: async ({ location }) => {
    await requireAuthentication(location.href);
    if (!session.getState().claims?.admin) {
      throw redirect({ to: "/" });
    }
  },
  component: AdminPage,
});

const routeTree = rootRoute.addChildren([loginRoute, treeRoute, adminRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
