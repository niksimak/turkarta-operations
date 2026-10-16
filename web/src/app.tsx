import { useEffect, useState } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { shouldRetry } from "./lib/api";
import { Shell } from "./components/Shell";
import { LoginFailed } from "./routes/LoginFailed";
import { Inbox } from "./routes/Inbox";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 15_000 },
      mutations: { retry: false },
    },
  });
}

// Holds the place for the view a later task builds, so navigation works end to end now.
function ViewPlaceholder({ title }: { title: string }) {
  useEffect(() => {
    document.title = `${title} · Поддержка`;
  }, [title]);
  return (
    <section className="px-6 py-5">
      <h1 className="text-xl font-semibold">{title}</h1>
    </section>
  );
}

export const routes = [
  { path: "/login-failed", element: <LoginFailed /> },
  {
    path: "/",
    element: <Shell />,
    children: [
      {
        // One Inbox instance for every view and the open ticket, so the list keeps its scroll.
        element: <Inbox />,
        children: [{ index: true }, { path: "mine" }, { path: "all" }, { path: "t/:id" }],
      },
      { path: "stats", element: <ViewPlaceholder title="Статистика" /> },
      { path: "canned", element: <ViewPlaceholder title="Шаблоны" /> },
      { path: "settings", element: <ViewPlaceholder title="Настройки" /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
];

export function App({ queryClient }: { queryClient?: QueryClient }) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const [router] = useState(() => createBrowserRouter(routes, { basename: "/crm" }));
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
