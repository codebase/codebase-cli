/**
 * A message a director sends OUT to a person — a notification, a question,
 * a status update. Channel-agnostic: the same message can go out as email,
 * a Teams post, an SMS, or a spoken Ultravox call.
 */
export interface OutboundMessage {
	/** Used by channels that have one (email, Teams). Ignored by SMS/voice. */
	subject?: string;
	body: string;
}

/**
 * A way to reach a person. The director core calls `send` without knowing
 * (or caring) whether it becomes an email, a Teams message, etc. New
 * channels are added by writing one adapter that implements this — the
 * director logic never changes.
 *
 * Inbound (the person → the director: a task, a reply, an approval) is a
 * separate concern handled later via webhooks; see the comms roadmap.
 */
export interface Channel {
	/** Stable id for config + logging, e.g. "email", "teams", "sms", "voice". */
	readonly name: string;
	/** Deliver a message to a recipient address/handle on this channel. */
	send(to: string, message: OutboundMessage): Promise<void>;
}
