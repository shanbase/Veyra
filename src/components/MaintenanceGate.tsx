import { useEffect, useState } from "react";
import { ServerOff, ArrowRight } from "lucide-react";

const STATUS_PAGE_URL = "https://uptime-kuma.go.altare.global/status/veyra";

type GateState = "loading" | "up" | "down";

/**
 * Shows a maintenance screen when the API reports maintenance mode. The check
 * fails open: if /api/maintenance is unreachable or missing (older server),
 * the app renders normally rather than locking users out.
 */
export function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>("loading");

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    fetch("/api/maintenance", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (alive) setState(data?.maintenance ? "down" : "up");
      })
      .catch(() => {
        if (alive) setState("up");
      })
      .finally(() => clearTimeout(timer));
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  if (state === "loading") {
    return (
      <div className="grid min-h-svh place-items-center bg-background" role="status" aria-label="Loading">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  if (state === "down") {
    return (
      <div className="grid min-h-svh place-items-center bg-background p-6">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10">
            <ServerOff className="h-7 w-7 text-amber-500" />
          </div>
          <h1 className="text-xl font-semibold">We're working on the server!</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            We'll be back soon — thanks for your patience.
          </p>
          <a
            href={STATUS_PAGE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            Check server status
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
