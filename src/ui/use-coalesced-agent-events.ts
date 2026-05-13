import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { useEffect, useRef } from "react";
import type { AgentBundle } from "../agent/agent.js";

type Dispatch = (action: { type: "agent-event"; event: AgentEvent }) => void;

/**
 * Coalesce high-frequency streaming events (per-token assistant updates
 * and per-chunk tool stdout) to one React commit per frame instead of
 * per event. Pi-agent-core emits one message_update per token, and a
 * fast model + long tool output can fire 100+ Hz — each dispatch runs
 * the full reducer + React tree diff + Yoga layout for everything on
 * screen. Throttling here is the single biggest cause of perceived
 * scroll/render jankiness; everything else (Static for finalized
 * messages, memoized children) is icing.
 *
 * Keyed coalescing: message_update has one slot, tool_execution_update
 * has one slot per tool id. Latest event wins. Non-coalesceable events
 * (message_start/end, tool_execution_start/end, turn_*, agent_*) flush
 * any pending updates first so ordering stays correct.
 */
export function useCoalescedAgentEvents(bundle: AgentBundle, dispatch: Dispatch): void {
	const pendingRef = useRef<Map<string, AgentEvent>>(new Map());
	const flushTimerRef = useRef<NodeJS.Timeout | null>(null);

	useEffect(() => {
		const STREAM_FRAME_MS = 16; // ~60fps cap

		const flush = () => {
			flushTimerRef.current = null;
			if (pendingRef.current.size === 0) return;
			const events = [...pendingRef.current.values()];
			pendingRef.current.clear();
			for (const event of events) {
				dispatch({ type: "agent-event", event });
			}
		};

		const scheduleFlush = () => {
			if (flushTimerRef.current != null) return;
			flushTimerRef.current = setTimeout(flush, STREAM_FRAME_MS);
		};

		const unsubscribe = bundle.subscribe((event) => {
			if (event.type === "message_update") {
				pendingRef.current.set("msg", event);
				scheduleFlush();
				return;
			}
			if (event.type === "tool_execution_update") {
				pendingRef.current.set(`tool:${event.toolCallId}`, event);
				scheduleFlush();
				return;
			}
			// Any other event flushes the queue before dispatching so the
			// reducer sees pending streaming updates before the terminal
			// event (message_end, tool_execution_end, etc.).
			if (pendingRef.current.size > 0) {
				if (flushTimerRef.current != null) {
					clearTimeout(flushTimerRef.current);
					flushTimerRef.current = null;
				}
				flush();
			}
			dispatch({ type: "agent-event", event });
		});

		return () => {
			unsubscribe();
			if (flushTimerRef.current != null) {
				clearTimeout(flushTimerRef.current);
				flushTimerRef.current = null;
			}
			pendingRef.current.clear();
		};
	}, [bundle, dispatch]);
}
