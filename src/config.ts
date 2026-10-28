import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, chmod } from "node:fs/promises";

export const BASE_URL = "https://myintkoaung4--ep-muse-spark-open-816b-a42b-server.us-west.modal.direct/v1";
export const MODEL = "meta-models/Muse-Spark-Open-816B-A42B";
export const configDir = join(homedir(), ".arguscli");
export const configPath = join(configDir, "config.json");
export type Credentials = { tokenId: string; tokenSecret: string };

export function parseCredentials(value: unknown): Credentials {
  if (!value || typeof value !== "object") throw new Error("Invalid saved connection. Run /connect again.");
  const c = value as Record<string, unknown>;
  if (typeof c.tokenId !== "string" || typeof c.tokenSecret !== "string" || !c.tokenId.trim() || !c.tokenSecret.trim()) {
    throw new Error("Both the Modal token ID and secret are required.");
  }
  return { tokenId: c.tokenId.trim(), tokenSecret: c.tokenSecret.trim() };
}

export async function loadCredentials(): Promise<Credentials | null> {
  const file = Bun.file(configPath);
  if (await file.exists()) return parseCredentials(await file.json());
  if (process.env.MODAL_PROXY_TOKEN_ID && process.env.MODAL_PROXY_TOKEN_SECRET) {
    return parseCredentials({ tokenId: process.env.MODAL_PROXY_TOKEN_ID, tokenSecret: process.env.MODAL_PROXY_TOKEN_SECRET });
  }
  return null;
}

export async function saveCredentials(credentials: Credentials) {
  const checked = parseCredentials(credentials);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await Bun.write(configPath, JSON.stringify(checked, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") await chmod(configPath, 0o600);
}
