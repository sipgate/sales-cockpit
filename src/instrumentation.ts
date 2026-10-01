// Next.js-Instrumentation: startet den Runtime-Poller beim Server-Start
// (Boot-Poll sofort, danach Timer-Takte je Quelle, siehe
// src/lib/runtime/poller.ts). Läuft nur im Server-Prozess, nicht im
// Browser-Bundle und nicht während des Builds.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { installProxyDispatcher } = await import('./lib/sources/proxy');
  installProxyDispatcher();
  const { startPoller } = await import('./lib/runtime/poller');
  startPoller();
}
