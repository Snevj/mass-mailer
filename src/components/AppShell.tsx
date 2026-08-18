"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import ThemeToggle from "@/components/ThemeToggle";
import Logo from "@/components/Logo";
import CommandPalette from "@/components/CommandPalette";

const NAV = [
  { href: "/", label: "Campaigns", icon: CampaignIcon },
  { href: "/replies", label: "Replies", icon: ReplyIcon },
  { href: "/senders", label: "Senders", icon: MailIcon },
  { href: "/unsubscribes", label: "Unsubscribes", icon: UnsubscribeIcon },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  function isActive(href: string) {
    if (href === "/") return pathname === "/" || pathname.startsWith("/campaigns");
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <div className="min-h-screen flex bg-paper text-ink">
      {/* sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-60 bg-surface border-r border-ink-200 flex flex-col
          transform transition-transform md:translate-x-0
          ${mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}
      >
        <div className="px-4 pt-5 pb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-ink">
            <Logo size={22} />
            <span className="font-semibold text-[14px] tracking-tight">Mailvia</span>
          </div>
          <button className="md:hidden btn-quiet p-1" onClick={() => setMobileOpen(false)}>
            <Icon path="M6 6l12 12M6 18L18 6" />
          </button>
        </div>

        <div className="px-2 flex-1 overflow-y-auto">
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500 px-2 pt-2 pb-1">
            Workspace
          </div>
          <nav className="space-y-0.5">
            {NAV.map((n) => {
              const Icon = n.icon;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`side-link ${isActive(n.href) ? "side-link-active" : ""}`}
                  onClick={() => setMobileOpen(false)}
                >
                  <Icon />
                  <span>{n.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500 px-2 pt-5 pb-1">
            Actions
          </div>
          <Link
            href="/campaigns/new"
            className="side-link"
            onClick={() => setMobileOpen(false)}
          >
            <Icon path="M12 5v14M5 12h14" />
            <span>New campaign</span>
          </Link>
        </div>

        <div className="p-2 border-t border-ink-200 space-y-0.5">
          <Link
            href="/settings"
            className={`side-link ${isActive("/settings") ? "side-link-active" : ""}`}
            onClick={() => setMobileOpen(false)}
          >
            <Icon path="M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            <span>Settings</span>
          </Link>
          <ThemeToggle />
          <button onClick={logout} className="side-link w-full text-left">
            <Icon path="M15 17l5-5-5-5M20 12H9M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {/* mobile top bar */}
      <div className="md:hidden fixed top-0 inset-x-0 h-12 bg-paper border-b border-ink-200 z-30 flex items-center justify-between px-4">
        <button onClick={() => setMobileOpen(true)} className="btn-quiet p-1">
          <Icon path="M4 6h16M4 12h16M4 18h16" />
        </button>
        <div className="flex items-center gap-1.5 text-ink">
          <Logo size={18} />
          <span className="font-semibold text-[14px] tracking-tight">Mailvia</span>
        </div>
        <div className="w-7" />
      </div>

      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/30 z-30"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* main */}
      <main className="flex-1 md:ml-60 pt-12 md:pt-0 min-w-0">
        {children}
      </main>

      <CommandPalette />
    </div>
  );
}

function Icon({ path }: { path: string }) {
  return (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

function CampaignIcon() {
  return (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8l9 6 9-6M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  );
}

function ReplyIcon() {
  return (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 17l-5-5 5-5M4 12h11a5 5 0 015 5v2" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function UnsubscribeIcon() {
  return (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2L2 22M21 5H9a2 2 0 00-2 2v10M3 19V7a2 2 0 012-2" />
    </svg>
  );
}
