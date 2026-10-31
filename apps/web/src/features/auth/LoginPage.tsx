import { FormEvent, useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { session } from "../../auth/session";
import { ApiError } from "../../lib/api";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";

const routeApi = getRouteApi("/login");

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "invalid_credentials":
        return "Email or password is incorrect.";
      case "account_disabled":
        return "This account is disabled.";
      case "too_many_attempts":
        return "Too many attempts. Try again in a minute.";
      default:
        return err.message;
    }
  }
  return "Login failed.";
}

export function LoginPage() {
  const navigate = useNavigate();
  const search = routeApi.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await session.login(email, password);
      const target = search.redirect?.startsWith("/") ? search.redirect : "/";
      await navigate({ to: target });
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-[0_16px_50px_rgba(16,26,60,0.10)]">
      <form onSubmit={onSubmit} className="space-y-4">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink">Email</span>
          <Input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink">Password</span>
          <Input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="text-sm text-rose-600 dark:text-rose-300" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
