export interface UserQuery {
	id: string;
	question: string;
	/** Optional list of options. If present, the UI renders them as a numbered choice list. */
	options?: string[];
	/** Hint shown in the input row before the user types. */
	placeholder?: string;
}

export type UserQueryListener = (query: UserQuery | undefined) => void;

export class UserQueryCancelled extends Error {
	constructor() {
		super("user cancelled the query");
		this.name = "UserQueryCancelled";
	}
}

/**
 * Per-agent-instance store that the ask_user tool blocks on. Mirrors the
 * shape of PermissionStore — queue of pending requests, FIFO processing,
 * UI subscribes to render the head and resolve via respond().
 */
export class UserQueryStore {
	private readonly queue: Array<{
		query: UserQuery;
		resolve: (answer: string) => void;
		reject: (err: Error) => void;
	}> = [];
	private readonly listeners = new Set<UserQueryListener>();
	private counter = 0;

	ask(input: { question: string; options?: string[]; placeholder?: string }): Promise<string> {
		return new Promise((resolve, reject) => {
			const query: UserQuery = {
				id: `q-${++this.counter}`,
				question: input.question,
				options: input.options,
				placeholder: input.placeholder,
			};
			this.queue.push({ query, resolve, reject });
			this.notify();
		});
	}

	current(): UserQuery | undefined {
		return this.queue[0]?.query;
	}

	subscribe(listener: UserQueryListener): () => void {
		this.listeners.add(listener);
		listener(this.current());
		return () => {
			this.listeners.delete(listener);
		};
	}

	respond(id: string, answer: string): void {
		const head = this.queue[0];
		if (!head || head.query.id !== id) return;
		head.resolve(answer);
		this.queue.shift();
		this.notify();
	}

	cancel(id: string): void {
		const head = this.queue[0];
		if (!head || head.query.id !== id) return;
		head.reject(new UserQueryCancelled());
		this.queue.shift();
		this.notify();
	}

	private notify(): void {
		const cur = this.current();
		for (const listener of this.listeners) listener(cur);
	}
}
