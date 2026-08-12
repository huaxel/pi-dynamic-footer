import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function codexBarConfigPath(): string | undefined {
  const explicit = process.env.CODEXBAR_CONFIG?.trim();
  if (explicit) return explicit;

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const xdgPath =
    xdg && xdg.startsWith("/") ? join(xdg, "codexbar", "config.json") : undefined;
  const defaultPath = join(homedir(), ".config", "codexbar", "config.json");
  const legacyPath = join(homedir(), ".codexbar", "config.json");

  if (xdgPath && existsSync(xdgPath)) return xdgPath;
  if (existsSync(defaultPath)) return defaultPath;
  if (existsSync(legacyPath)) return legacyPath;
  return undefined;
}

export function codexBarProviderCookie(providerId: string): string | undefined {
  const configPath = codexBarConfigPath();
  if (!configPath) return undefined;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const providers = Array.isArray(config.providers) ? config.providers : [];
    const entry = providers.find((provider: { id?: string }) => provider?.id === providerId);
    const cookieHeader = entry?.cookieHeader;
    return typeof cookieHeader === "string" && cookieHeader.trim() ? cookieHeader.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function envCookie(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}
