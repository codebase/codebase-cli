import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { CompactionMemo } from "./memo.js";

let clock = 0;
const msg = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: ++clock });
const texts = (ms: AgentMessage[]) => ms.map((m) => m.content);

describe("CompactionMemo", () => {
	it("passes messages through until a compaction is recorded", () => {
		const memo = new CompactionMemo();
		const ms = [msg("a"), msg("b")];
		expect(memo.apply(ms)).toBe(ms);
	});

	it("reuses the summary for the covered head on later requests", () => {
		const memo = new CompactionMemo();
		const ms = [msg("a"), msg("b"), msg("c"), msg("d")];
		const view = memo.apply(ms);
		memo.record(ms, view, [msg("S"), msg("ack"), ms[2], ms[3]], 2);

		ms.push(msg("e"));
		expect(texts(memo.apply(ms))).toEqual(["S", "ack", "c", "d", "e"]);
	});

	it("maps a second compaction back onto the original transcript", () => {
		const memo = new CompactionMemo();
		const ms = [msg("a"), msg("b"), msg("c"), msg("d")];
		memo.record(ms, memo.apply(ms), [msg("S1"), msg("ack"), ms[2], ms[3]], 2);

		ms.push(msg("e"), msg("f"));
		const view = memo.apply(ms); // S1 ack c d e f
		memo.record(ms, view, [msg("S2"), msg("ack"), ms[4], ms[5]], 4);

		ms.push(msg("g"));
		expect(texts(memo.apply(ms))).toEqual(["S2", "ack", "e", "f", "g"]);
	});

	it("drops the memo when the covered history changes (rewind / session swap)", () => {
		const memo = new CompactionMemo();
		const ms = [msg("a"), msg("b"), msg("c")];
		memo.record(ms, memo.apply(ms), [msg("S"), msg("ack"), ms[2]], 2);

		const rewound = [ms[0]];
		expect(memo.apply(rewound)).toBe(rewound);
		const other = [msg("x"), msg("y"), msg("z")];
		expect(memo.apply(other)).toBe(other);
	});

	it("survives a save/load round trip through the session file", () => {
		const memo = new CompactionMemo();
		const ms = [msg("a"), msg("b"), msg("c")];
		memo.record(ms, memo.apply(ms), [msg("S"), msg("ack"), ms[2]], 2);
		const saved = JSON.parse(JSON.stringify({ messages: ms, compaction: memo.snapshot() }));

		const restored = new CompactionMemo();
		restored.restore(saved.compaction, saved.messages);
		expect(texts(restored.apply(saved.messages))).toEqual(["S", "ack", "c"]);
	});

	it("ignores a snapshot that no longer matches the transcript", () => {
		const memo = new CompactionMemo();
		const ms = [msg("a"), msg("b"), msg("c")];
		memo.record(ms, memo.apply(ms), [msg("S"), msg("ack"), ms[2]], 2);
		const snapshot = memo.snapshot();

		const other = [msg("x"), msg("y"), msg("z")];
		const restored = new CompactionMemo();
		restored.restore(snapshot, other);
		expect(restored.apply(other)).toBe(other);
		restored.restore(snapshot, [ms[0]]);
		expect(restored.snapshot()).toBeUndefined();
	});
});
