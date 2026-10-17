import { useState } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { shouldRetry } from "./lib/api";
import { Shell } from "./components/Shell";
import { LoginFailed } from "./routes/LoginFailed";
import { Inbox } from "./routes/Inbox";
import { Canned } from "./routes/Canned";
import { Settings } from "./routes/Settings";
import { Stats } from "./routes/Stats";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 15_000 },
      mutations: { retry: false },
    },
  });
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
      { path: "stats", element: <Stats /> },
      { path: "canned", element: <Canned /> },
      { path: "settings", element: <Settings /> },
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
