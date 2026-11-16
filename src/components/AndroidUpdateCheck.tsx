import { useEffect, useRef, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { toast } from '@/hooks/use-toast';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

// Served by the Veyra API, which fetches the GitHub release metadata
// server-side. Fetching github.com directly fails in the Android WebView
// because release downloads redirect to asset hosts without CORS headers.
const RELEASE_URL = '/api/app-version';
// The Android shell loads the deployed web app, so VITE_APP_VERSION reflects
// the web build — not the installed APK. The native package version (stamped
// by scripts/configure-android-release.mjs at build time) is the source of
// truth; the env var is only a fallback for older shells.
const BUILD_VERSION = import.meta.env.VITE_APP_VERSION || '';

function normalizeVersion(value: string) {
  return value.trim().replace(/^v/i, '');
}

async function installedVersion() {
  try {
    const info = await App.getInfo();
    const native = normalizeVersion(info?.version || '');
    if (native) return native;
  } catch {
    // Older shells may not expose App.getInfo; fall through to the build env.
  }
  return normalizeVersion(BUILD_VERSION) || '0.0.0';
}

function compareVersions(left: string, right: string) {
  // Extract the leading digits of each part so pre-release/build suffixes
  // ('1.2.3-beta', '1.2.3+build') still compare numerically.
  const parse = (value: string) => normalizeVersion(value)
    .split('.')
    .map((part) => Number(part.match(/^\d+/)?.[0] ?? NaN));
  const a = parse(left); const b = parse(right);
  const length = Math.max(a.length, b.length, 3);
  if (a.length > 4 || b.length > 4 || [...a, ...b].some((part) => !Number.isInteger(part) || part < 0)) return 0;
  for (let i = 0; i < length; i++) {
    const leftPart = a[i] ?? 0; const rightPart = b[i] ?? 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

type ReleaseInfo = {
  version?: string;
  tag?: string;
  notes?: string;
  name?: string;
  // Minimum native shell version that must be installed. The app is a web
  // shell, so website-only releases don't require an APK update — only
  // releases that bump this floor (native plugins/permissions changes) do.
  min_app_version?: string;
  android?: { file?: string; url?: string };
};

type DownloadState = 'idle' | 'downloading' | 'applying' | 'error';

interface AppUpdatePlugin {
  downloadAndInstall(options: { url: string }): Promise<void>;
  cancel(): Promise<void>;
  addListener(
    eventName: 'downloadProgress',
    listenerFunc: (event: { received: number; total: number }) => void,
  ): Promise<{ remove: () => void }>;
  addListener(
    eventName: 'downloadReady' | 'downloadFailed' | 'downloadCancelled' | 'installFailed',
    listenerFunc: (event: { error?: string }) => void,
  ): Promise<{ remove: () => void }>;
}

const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate');

function formatMb(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AndroidUpdateCheck() {
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [currentVersion, setCurrentVersion] = useState(BUILD_VERSION || '…');
  const [download, setDownload] = useState<DownloadState>('idle');
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  // Native download progress + lifecycle events.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;
    const handles: { remove: () => void }[] = [];
    void (async () => {
      handles.push(await AppUpdate.addListener('downloadProgress', (event) => {
        setReceived(event.received || 0);
        if (event.total > 0) setTotal(event.total);
      }));
      handles.push(await AppUpdate.addListener('downloadReady', () => {
        setDownload('applying');
      }));
      handles.push(await AppUpdate.addListener('downloadFailed', (event) => {
        setError(event.error || 'Download failed.');
        setDownload('error');
      }));
      handles.push(await AppUpdate.addListener('installFailed', (event) => {
        setError(event.error || 'Could not open the installer.');
        setDownload('error');
      }));
      handles.push(await AppUpdate.addListener('downloadCancelled', () => {
        setDownload('idle');
      }));
    })().catch(() => {});
    return () => {
      for (const handle of handles) void handle.remove();
    };
  }, []);

  const checkForUpdate = async () => {
    try {
      const installed = await installedVersion();
      setCurrentVersion(installed);
      const response = await fetch(RELEASE_URL, { cache: 'no-store' });
      if (response.status === 404) return; // No published release yet.
      if (!response.ok) throw new Error(`Release check failed (HTTP ${response.status}).`);
      const info = await response.json() as ReleaseInfo;
      // Only prompt when the installed shell is older than the required
      // minimum — the web content is always live, so a newer release tag
      // alone doesn't justify an APK download. Older latest.json files
      // without the field fall back to comparing the release version.
      const required = normalizeVersion(info.min_app_version || info.version || '');
      if (!info.version || !info.android?.url || !required || compareVersions(required, installed) <= 0) return;
      setRelease(info);
      setOpen(true);
    } catch (error) {
      console.warn('Could not check for Android updates:', error);
      toast({
        title: 'Update check failed',
        description: 'Veyra could not reach the release server. You are still running the current version.',
        variant: 'destructive',
      });
    }
  };

  // Updates are manual-only: Settings dispatches this event when the user
  // taps "Check for updates". The app stays on its installed version until
  // then — the web content is always live anyway.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;
    const onManualCheck = () => void checkForUpdate();
    window.addEventListener('veyra:check-app-updates', onManualCheck);
    return () => window.removeEventListener('veyra:check-app-updates', onManualCheck);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-start the download as soon as an update is found — the native side
  // reports progress and launches the system installer when the APK is ready.
  useEffect(() => {
    const url = release?.android?.url;
    if (!open || !url || startedRef.current || download !== 'idle') return;
    startedRef.current = true;
    setDownload('downloading');
    AppUpdate.downloadAndInstall({ url }).catch((error) => {
      console.warn('Could not start the Android update download:', error);
      setError(error?.message || 'Could not start the download.');
      setDownload('error');
    });
  }, [open, release, download]);

  const cancelDownload = async () => {
    try {
      await AppUpdate.cancel();
    } catch {
      // Native side may already be done; ignore.
    }
    startedRef.current = false;
    setDownload('idle');
    setReceived(0);
    setTotal(0);
    setOpen(false);
  };

  const retry = () => {
    startedRef.current = false;
    setError(null);
    setReceived(0);
    setTotal(0);
    setDownload('idle');
  };

  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && download === 'idle') setOpen(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Veyra {release?.version} is available</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {download === 'downloading' && (
                <div className="space-y-2">
                  <p>
                    Downloading update… {formatMb(received)}
                    {total > 0 ? ` / ${formatMb(total)}` : ''}
                    {percent !== null ? ` (${percent}%)` : ''}
                  </p>
                  <Progress value={percent ?? undefined} />
                </div>
              )}
              {download === 'applying' && (
                <p>Applying update… the installer will open in a moment.</p>
              )}
              {download === 'error' && (
                <p className="text-destructive">{error || 'Update failed.'}</p>
              )}
              {download === 'idle' && (
                <p>You are running Veyra {currentVersion}.</p>
              )}
              {release?.notes || release?.name ? (
                <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                  {release.notes || release.name}
                </p>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {download === 'downloading' ? (
            <Button variant="outline" onClick={() => void cancelDownload()}>
              Cancel
            </Button>
          ) : download === 'error' ? (
            <>
              <Button variant="outline" onClick={() => { setOpen(false); }}>Later</Button>
              <Button onClick={retry}>Retry</Button>
            </>
          ) : download === 'idle' ? (
            <Button variant="outline" onClick={() => setOpen(false)}>Later</Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
