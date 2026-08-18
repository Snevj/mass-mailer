"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Logo from "@/components/Logo";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setLoading(false);
    if (!res.ok) {
      if (res.status === 429) {
        const d = await res.json().catch(() => ({}));
        const mins = Math.ceil((d.retry_after_seconds ?? 0) / 60);
        setErr(`Too many attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
      } else {
        setErr("Wrong password.");
      }
      return;
    }
    const next = new URLSearchParams(window.location.search).get("next") || "/";
    router.push(next);
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-paper">
      <form onSubmit={onSubmit} className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-10 text-ink">
          <Logo size={28} />
          <span className="font-semibold text-[16px] tracking-tight">Mailvia</span>
        </div>

        <h1 className="text-xl font-semibold mb-1">Sign in</h1>
        <p className="text-[13px] text-ink-500 mb-8">Enter the workspace password to continue.</p>

        <div className="space-y-5">
          <div>
            <label htmlFor="login-password" className="label-cap">Password</label>
            <input
              id="login-password"
              className="field-boxed"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {err && (
            <p className="text-[13px] text-red-600">{err}</p>
          )}

          <button type="submit" disabled={loading || !password} className="btn-accent w-full">
            {loading ? "Signing in…" : "Continue"}
          </button>
        </div>
      </form>
    </div>
  );
}
