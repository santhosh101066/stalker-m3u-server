import { initialConfig } from "@/config/server";

// Normalizes a portal channel logo reference to a portal-root path suitable
// for the /api/images proxy (e.g. "/stalker_portal/misc/logos/320/1.png").
// Stalker portals usually store just a filename; some store a partial path.
export function channelLogoPath(logo?: string): string {
  if (!logo) return "";
  if (logo.startsWith("http")) return logo; // already an absolute URL
  const ctx = initialConfig.contextPath ? `/${initialConfig.contextPath}` : "";
  if (logo.includes("/")) {
    return `${ctx}/${logo.replace(/^\//, "")}`;
  }
  return `${ctx}/misc/logos/320/${logo}`;
}

// Logo reference → same-origin proxied path the web app and players can load
// (avoids mixed-content blocks and portals unreachable from the client).
export function proxiedLogoPath(logo?: string): string {
  const p = channelLogoPath(logo);
  if (!p || p.startsWith("http")) return p;
  return `/api/images${p}`;
}
