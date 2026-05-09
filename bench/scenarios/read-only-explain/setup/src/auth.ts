// Session shape + a tiny gate that throws when the caller is unauthenticated.
// Used by every mutation in src/index.ts.

export interface Session {
	userId: string;
	expiresAt: number;
}

export class AuthError extends Error {}

export function requireSession(session: Session | null | undefined): asserts session is Session {
	if (!session) throw new AuthError("no session");
	if (session.expiresAt < Date.now()) throw new AuthError("session expired");
	if (!session.userId) throw new AuthError("session missing userId");
}
