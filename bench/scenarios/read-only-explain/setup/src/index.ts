// Tiny in-memory todo API. The HTTP layer lives in src/server.ts;
// authentication is checked through src/auth.ts on every mutation.
import { type Session, requireSession } from "./auth.ts";

export interface Todo {
	id: string;
	title: string;
	done: boolean;
	ownerId: string;
}

const TODOS = new Map<string, Todo>();

export function listTodos(session: Session): readonly Todo[] {
	requireSession(session);
	return [...TODOS.values()].filter((t) => t.ownerId === session.userId);
}

export function createTodo(session: Session, title: string): Todo {
	requireSession(session);
	const id = crypto.randomUUID();
	const todo: Todo = { id, title, done: false, ownerId: session.userId };
	TODOS.set(id, todo);
	return todo;
}

export function completeTodo(session: Session, id: string): Todo {
	requireSession(session);
	const existing = TODOS.get(id);
	if (!existing || existing.ownerId !== session.userId) {
		throw new Error("not found");
	}
	const updated = { ...existing, done: true };
	TODOS.set(id, updated);
	return updated;
}
