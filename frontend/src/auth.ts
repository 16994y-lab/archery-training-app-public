const tokenKey = "archery-access-token";
const refreshKey = "archery-refresh-token";
const authEnv = import.meta.env ?? {};

export const configured = Boolean(authEnv.VITE_SUPABASE_URL && authEnv.VITE_SUPABASE_PUBLISHABLE_KEY);
export const token = () => localStorage.getItem(tokenKey);

export type AuthContext = Readonly<{
  mode: "LOCAL_ONLY" | "AUTHENTICATED" | "SIGNED_OUT" | "OFFLINE_UNVERIFIED";
  ownerScope: string | null;
  userId: string | null;
  email: string | null;
}>;

type SupabaseUser = { id?: unknown; email?: unknown };
type AuthResponse = { access_token?: string; refresh_token?: string; user?: SupabaseUser };

class AuthHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "AuthHttpError"; this.status = status; }
}

export function createAuthAttemptGate() {
  let generation = 0;
  return {
    begin() { generation += 1; return generation; },
    invalidate() { generation += 1; },
    accepts(ticket: number) { return ticket === generation; },
    get generation() { return generation; },
  };
}

const authAttempts = createAuthAttemptGate();
let verifiedSession: { accessToken: string; ownerScope: string } | null = null;
export function isVerifiedOwnerCurrent(ownerScope: string): boolean {
  return !configured || Boolean(verifiedSession && verifiedSession.ownerScope === ownerScope && verifiedSession.accessToken === token());
}
export function verifiedTokenFor(ownerScope: string): string | null {
  if (!configured) return null;
  if (!isVerifiedOwnerCurrent(ownerScope)) throw new Error("账户已变化，请等待重新验证身份");
  return verifiedSession!.accessToken;
}
export const isAuthStorageKey = (key: string | null) => key === null || key === tokenKey || key === refreshKey;
const signedOut = (mode: "SIGNED_OUT" | "OFFLINE_UNVERIFIED" = "SIGNED_OUT"): AuthContext => Object.freeze({ mode, ownerScope: null, userId: null, email: null });

export const localOnlyAuthContext = (): AuthContext => Object.freeze({
  mode: "LOCAL_ONLY",
  ownerScope: "local-dev",
  userId: "local-dev",
  email: null,
});

export function authenticatedContext(user: SupabaseUser): AuthContext | null {
  const id = typeof user.id === "string" ? user.id.trim() : "";
  if (!id) return null;
  return Object.freeze({
    mode: "AUTHENTICATED",
    ownerScope: id,
    userId: id,
    email: typeof user.email === "string" && user.email.trim() ? user.email.trim() : null,
  });
}

export function clearStoredSession() {
  authAttempts.invalidate();
  verifiedSession = null;
  localStorage.removeItem(tokenKey);
  localStorage.removeItem(refreshKey);
}

export const signOut = clearStoredSession;

async function authRequest(path: string, init: RequestInit) {
  const response = await fetch(`${authEnv.VITE_SUPABASE_URL}/auth/v1/${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      apikey: authEnv.VITE_SUPABASE_PUBLISHABLE_KEY!,
      ...(init.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({})) as AuthResponse & { msg?: string; error_description?: string };
  if (!response.ok) throw new AuthHttpError(response.status, data.msg || data.error_description || "账户操作失败");
  return data;
}

async function request(path: string, body: Record<string, unknown>) {
  const attempt = authAttempts.begin();
  const data = await authRequest(path, { method: "POST", body: JSON.stringify(body) });
  if (!authAttempts.accepts(attempt)) throw new Error("较早的账户操作已失效，请使用当前登录状态");
  if (data.access_token) {
    verifiedSession = null;
    localStorage.setItem(tokenKey, data.access_token);
    if (data.refresh_token) localStorage.setItem(refreshKey, data.refresh_token);
  }
  return data;
}

export async function resolveAuthContext(): Promise<AuthContext> {
  if (!configured) return localOnlyAuthContext();
  const attempt = authAttempts.begin();
  verifiedSession = null;
  const accessToken = token();
  if (!accessToken) return signedOut();
  const current = () => authAttempts.accepts(attempt) && accessToken === token();
  try {
    // Unique URL also avoids a private response cached by the previous generic worker.
    const user = await authRequest(`user?verification=${crypto.randomUUID()}`, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } });
    if (!current()) return signedOut();
    const context = authenticatedContext(user as SupabaseUser);
    if (!context) { clearStoredSession(); return signedOut(); }
    verifiedSession = { accessToken, ownerScope: context.ownerScope! };
    return context;
  } catch (error) {
    if (!current()) return signedOut();
    if (error instanceof AuthHttpError && (error.status === 401 || error.status === 403)) {
      clearStoredSession();
      return signedOut();
    }
    // A network outage is not evidence that the stored session is invalid. Keep
    // the tokens, but fail closed: no owner cache or cloud request is available
    // until Supabase verifies the session again.
    return signedOut("OFFLINE_UNVERIFIED");
  }
}

export const signIn = (email: string, password: string) => request("token?grant_type=password", { email, password });
export const signUp = (email: string, password: string) => request("signup", { email, password });
