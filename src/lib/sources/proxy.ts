// Egress-Proxy der Nautilus-Plattform (Muster: growth-cockpit
// src/lib/sources/proxy.ts): Der Controller injiziert jedem Service-Pod
// http_proxy/https_proxy/no_proxy (per-Service Squid-Egress-Proxy,
// Allowlist aus den egressNetworkPolicies der nautilus.yaml). fetch
// (undici) liest diese Env-Variablen von selbst nicht — deshalb setzt
// diese Datei den globalen Dispatcher auf undicis EnvHttpProxyAgent,
// sobald eine Proxy-Variable steht. Ohne Proxy-Env (lokal, ohne Egress)
// bleibt alles beim Standard-Verhalten.

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

const PROXY_ENV_KEYS = [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
] as const;

/** Setzt den Proxy-Dispatcher genau einmal (idempotent über HMR-/Modul-
 *  Instanzen hinweg). Muss vor dem ersten fetch des Pollers laufen. */
export function installProxyDispatcher(): void {
  const g = globalThis as { __salesCockpitProxy?: boolean };
  if (g.__salesCockpitProxy) return;
  g.__salesCockpitProxy = true;

  const hasProxy = PROXY_ENV_KEYS.some((proxyKey) => process.env[proxyKey]);
  if (!hasProxy) return;

  setGlobalDispatcher(new EnvHttpProxyAgent());
  console.log('[sales-cockpit] Egress-Proxy aktiv (http_proxy/https_proxy)');
}
