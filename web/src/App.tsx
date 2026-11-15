import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router/dom";
import { Toaster } from "@/components/ui/sonner";
import { router } from "@/app/browser-router";
import { queryClient } from "@/lib/query";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  );
}
