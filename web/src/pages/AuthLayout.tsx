import type { ReactNode } from "react";

/** Centered card for the pages a visitor sees before login. */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background px-4 py-10">
      <span className="inline-flex items-center gap-2.5 font-display text-[26px] font-bold">
        <img src="/favicon.svg" alt="" className="size-8" />
        Laplace
      </span>
      <main className="flex w-full max-w-[380px] flex-col gap-4 rounded-lg border bg-card p-6">
        <h1 className="font-display text-[22px] leading-tight font-bold">{title}</h1>
        {children}
      </main>
    </div>
  );
}
