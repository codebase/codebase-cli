import { describe, expect, it, vi } from "vitest";
import { EmailChannel, type FetchLike, graphSendMailTransport } from "./email.js";

describe("EmailChannel", () => {
	it("delegates to the transport with a default subject", async () => {
		const transport = vi.fn().mockResolvedValue(undefined);
		const ch = new EmailChannel(transport);
		await ch.send("you@co.com", { body: "I'm blocked on a deploy." });
		expect(transport).toHaveBeenCalledWith("you@co.com", "(no subject)", "I'm blocked on a deploy.");
	});

	it("passes the subject through when given", async () => {
		const transport = vi.fn().mockResolvedValue(undefined);
		await new EmailChannel(transport).send("you@co.com", { subject: "Approval needed", body: "deploy?" });
		expect(transport).toHaveBeenCalledWith("you@co.com", "Approval needed", "deploy?");
	});
});

describe("graphSendMailTransport", () => {
	function okFetch(): {
		fetchImpl: FetchLike;
		calls: { url: string; init: { headers: Record<string, string>; body: string } }[];
	} {
		const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			calls.push({ url, init });
			return { ok: true, status: 202, text: async () => "" };
		};
		return { fetchImpl, calls };
	}

	it("POSTs sendMail with the bearer token and the right message shape", async () => {
		const { fetchImpl, calls } = okFetch();
		const transport = graphSendMailTransport({
			getAccessToken: async () => "TOK",
			from: "marketing@co.com",
			fetchImpl,
		});
		await transport("you@co.com", "Status", "done");

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/users/marketing%40co.com/sendMail");
		expect(calls[0].init.headers.Authorization).toBe("Bearer TOK");
		const payload = JSON.parse(calls[0].init.body);
		expect(payload.message.subject).toBe("Status");
		expect(payload.message.body.content).toBe("done");
		expect(payload.message.toRecipients[0].emailAddress.address).toBe("you@co.com");
	});

	it("sends as /me when no from is given", async () => {
		const { fetchImpl, calls } = okFetch();
		await graphSendMailTransport({ getAccessToken: async () => "T", fetchImpl })("a@b.com", "s", "b");
		expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
	});

	it("throws on a non-OK Graph response", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: false, status: 403, text: async () => "Forbidden" });
		const transport = graphSendMailTransport({ getAccessToken: async () => "T", fetchImpl });
		await expect(transport("a@b.com", "s", "b")).rejects.toThrow(/403.*Forbidden/);
	});
});
