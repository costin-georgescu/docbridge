import { useEffect } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { z } from "zod";
import { session } from "./auth/session";
import { useSession } from "./auth/useSession";
import { AdminPage } from "./features/admin/AdminPage";
import { LoginPage } from "./features/auth/LoginPage";
import { JobDetailPage } from "./features/jobs/JobDetailPage";
import { JobsPage } from "./features/jobs/JobsPage";
import { UploadPage } from "./features/uploads/UploadPage";
import { LogoMark, LogoTile } from "./components/Logo";
import { PillNav } from "./components/PillNav";
import { ThemeToggle } from "./components/ThemeToggle";

const NAV = [
  { to: "/", label: "Deliver" },
  { to: "/jobs", label: "Jobs" },
] as const;

function Layout() {
  const { status, claims } = useSession();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (status === "anonymous" && pathname !== "/login") {
      void navigate({ to: "/login" });
    }
  }, [status, pathname, navigate]);

  if (status === "anonymous") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 text-ink">
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-0 top-0 h-80 dark:bg-[radial-gradient(60rem_20rem_at_50%_-10rem,rgba(79,211,228,0.14),transparent)]"
        />
        <div className="fixed right-6 top-6">
          <ThemeToggle />
        </div>
        <span className="mb-6 flex items-center gap-2.5 text-base font-semibold tracking-tight">
          <LogoTile />
          DocBridge
        </span>
        <Outlet />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 h-80 dark:bg-[radial-gradient(60rem_20rem_at_50%_-10rem,rgba(79,211,228,0.14),transparent)]"
      />
      <div className="fixed inset-x-0 top-4 z-40 flex items-center justify-center px-4">
        <span className="absolute left-6 flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span className="flex size-7 items-center justify-center rounded-lg bg-[#4fd3e4] text-[#06283a]">
            <LogoMark />
          </span>
          DocBridge
        </span>
        {status === "authenticated" && (
          <PillNav
            items={[
              ...NAV,
              ...(claims?.admin ? [{ to: "/admin", label: "Admin" }] : []),
            ]}
          />
        )}
        <div className="absolute right-6 flex items-center gap-3">
          <ThemeToggle />
          {status === "authenticated" && claims && (
            <div className="flex items-center gap-2.5 rounded-full border border-line bg-surface/70 py-1 pl-1 pr-3 backdrop-blur-xl">
              <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
                {claims.name.slice(0, 1).toUpperCase()}
              </span>
              <button
                type="button"
                onClick={() => void session.logout()}
                className="text-xs font-medium text-muted hover:text-ink"
              >
                Logout
              </button>
            </div>
          )}
        </div>
      </div>
      <main className="mx-auto max-w-5xl px-6 pb-16 pt-24">
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

const deliverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: ({ location }) => requireAuthentication(location.href),
  component: UploadPage,
});

// Destinations browsing is folded into the deliver workspace; keep /upload
// as a redirect for old links.
const uploadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/upload",
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs",
  beforeLoad: ({ location }) => requireAuthentication(location.href),
  component: JobsPage,
});

const jobDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs/$jobId",
  beforeLoad: ({ location }) => requireAuthentication(location.href),
  component: JobDetailPage,
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

const routeTree = rootRoute.addChildren([
  loginRoute,
  deliverRoute,
  uploadRoute,
  jobsRoute,
  jobDetailRoute,
  adminRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
