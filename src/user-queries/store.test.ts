import { describe, expect, it, vi } from "vitest";
import { UserQueryCancelled, UserQueryStore } from "./store.js";

describe("UserQueryStore", () => {
	it("ask() resolves with the user's answer", async () => {
		const store = new UserQueryStore();
		const promise = store.ask({ question: "what's your name?" });
		const id = store.current()!.id;
		store.respond(id, "halfaipg");
		await expect(promise).resolves.toBe("halfaipg");
	});

	it("queues multiple asks in FIFO order", async () => {
		const store = new UserQueryStore();
		const a = store.ask({ question: "A?" });
		const b = store.ask({ question: "B?" });

		expect(store.current()?.question).toBe("A?");
		store.respond(store.current()!.id, "answerA");
		await expect(a).resolves.toBe("answerA");

		expect(store.current()?.question).toBe("B?");
		store.respond(store.current()!.id, "answerB");
		await expect(b).resolves.toBe("answerB");
	});

	it("cancel() rejects with UserQueryCancelled", async () => {
		const store = new UserQueryStore();
		const promise = store.ask({ question: "abandon?" });
		store.cancel(store.current()!.id);
		await expect(promise).rejects.toBeInstanceOf(UserQueryCancelled);
	});

	it("respond() with a stale id is a no-op", async () => {
		const store = new UserQueryStore();
		const promise = store.ask({ question: "still pending?" });
		store.respond("not-a-real-id", "noise");
		expect(store.current()).toBeDefined();
		store.respond(store.current()!.id, "real");
		await expect(promise).resolves.toBe("real");
	});

	it("notifies subscribers on queue and dequeue", async () => {
		const store = new UserQueryStore();
		const seen = vi.fn();
		store.subscribe(seen);
		expect(seen).toHaveBeenLastCalledWith(undefined);

		const promise = store.ask({ question: "?" });
		expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ question: "?" }));

		store.respond(store.current()!.id, "ok");
		await promise;
		expect(seen).toHaveBeenLastCalledWith(undefined);
	});

	it("preserves options and placeholder fields", () => {
		const store = new UserQueryStore();
		store.ask({
			question: "pick one",
			options: ["a", "b", "c"],
			placeholder: "type a/b/c or 1/2/3",
		});
		expect(store.current()?.options).toEqual(["a", "b", "c"]);
		expect(store.current()?.placeholder).toBe("type a/b/c or 1/2/3");
	});
});
