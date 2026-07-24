import { describe, expect, it, vi } from 'vitest';
import { SignalingClient, SignalingError } from '../src/signaling.js';
import type { TalkifClientConfig } from '../src/types.js';

function makeClient(fetchImpl: typeof fetch): SignalingClient {
	const config: TalkifClientConfig = {
		baseUrl: 'https://api.talkif.ai/',
		accountId: 'acc-1',
		auth: async () => 'Bearer test-token',
		fetch: fetchImpl,
	};
	return new SignalingClient(config);
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

describe('SignalingClient', () => {
	it('builds account-scoped URLs and sends auth headers', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { iceServers: [], ttl: 3600 }));
		const client = makeClient(fetchMock as unknown as typeof fetch);

		await client.getIceServers();

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://api.talkif.ai/api/v1/accounts/acc-1/calls/webrtc/ice-servers');
		expect(init.method).toBe('GET');
		expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer test-token');
	});

	it('POSTs the offer to the call-scoped path', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { sdp: 'v=0', sdpType: 'answer', botId: 'bot-1' }));
		const client = makeClient(fetchMock as unknown as typeof fetch);

		const answer = await client.sendOffer('call-9', { sdp: 'v=0offer', iceServers: [] });

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://api.talkif.ai/api/v1/accounts/acc-1/calls/webrtc/call-9/offer');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({ sdp: 'v=0offer', iceServers: [] });
		expect(answer.botId).toBe('bot-1');
	});

	it('throws SignalingError with backend message on non-2xx', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(422, { message: 'concurrent_call_limit_exceeded' }));
		const client = makeClient(fetchMock as unknown as typeof fetch);

		await expect(client.createCall({ flowId: 'f-1' })).rejects.toMatchObject({
			name: 'SignalingError',
			status: 422,
			message: 'concurrent_call_limit_exceeded',
		});
	});

	it('wraps non-JSON error bodies without throwing during parse', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('Bad Gateway', { status: 502 }));
		const client = makeClient(fetchMock as unknown as typeof fetch);

		const error = await client.getIceServers().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SignalingError);
		expect((error as SignalingError).body).toBe('Bad Gateway');
	});
});
