/**
 * Cloudflare Turnstile integration — the "prove you're a real browser" gate
 * that stops scripted abuse of the public call surface.
 *
 * The customer does nothing: the widget self-injects Cloudflare's script,
 * renders an invisible Turnstile widget with Talkif's sitekey, and produces a
 * fresh token for each session exchange. The sitekey is public and safe to
 * ship; the matching secret lives only in the backend.
 */

const TURNSTILE_SCRIPT_URL =
	'https://challenges.cloudflare.com/turnstile/v0/api.js';

/** Minimal shape of the global `turnstile` object we use. */
interface TurnstileApi {
	render(
		container: HTMLElement,
		options: {
			sitekey: string;
			callback?: (token: string) => void;
			'error-callback'?: (code?: string) => void;
			'expired-callback'?: () => void;
			size?: 'invisible' | 'normal' | 'compact' | 'flexible';
			execution?: 'render' | 'execute';
			retry?: 'auto' | 'never';
		}
	): string;
	execute(widgetId: string, options?: { sitekey?: string }): void;
	reset(widgetId: string): void;
	remove(widgetId: string): void;
}

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

let scriptPromise: Promise<void> | null = null;

/** Load Cloudflare's Turnstile script once, shared across all instances. */
function loadScript(): Promise<void> {
	if (typeof document === 'undefined') {
		return Promise.reject(new Error('Turnstile requires a browser environment'));
	}
	if (window.turnstile) return Promise.resolve();
	scriptPromise ??= new Promise<void>((resolve, reject) => {
		const existing = document.querySelector<HTMLScriptElement>(
			`script[src="${TURNSTILE_SCRIPT_URL}"]`
		);
		if (existing) {
			existing.addEventListener('load', () => resolve());
			existing.addEventListener('error', () => reject(new Error('Turnstile script failed to load')));
			if (window.turnstile) resolve();
			return;
		}
		const script = document.createElement('script');
		script.src = TURNSTILE_SCRIPT_URL;
		script.async = true;
		script.defer = true;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error('Turnstile script failed to load'));
		document.head.appendChild(script);
	});
	return scriptPromise;
}

/**
 * Manages one invisible Turnstile widget and hands out fresh tokens.
 *
 * Turnstile tokens are single-use and short-lived, so we `execute()` a fresh
 * challenge for each call to `getToken()` (i.e. each session exchange). The
 * widget is rendered lazily on first use and torn down with `dispose()`.
 */
export class TurnstileManager {
	private readonly siteKey: string;
	private container: HTMLDivElement | null = null;
	private widgetId: string | null = null;
	private pending: {
		resolve: (token: string) => void;
		reject: (err: Error) => void;
	} | null = null;

	constructor(siteKey: string) {
		this.siteKey = siteKey;
	}

	/** Obtain a fresh Turnstile token. Rejects if the challenge fails. */
	async getToken(): Promise<string> {
		await loadScript();
		const turnstile = window.turnstile;
		if (!turnstile) throw new Error('Turnstile unavailable after script load');

		if (!this.container) {
			// A hidden, off-screen host — the invisible widget never shows UI
			// but Cloudflare still requires an element to render into.
			this.container = document.createElement('div');
			this.container.style.position = 'fixed';
			this.container.style.width = '0';
			this.container.style.height = '0';
			this.container.style.overflow = 'hidden';
			this.container.style.pointerEvents = 'none';
			this.container.setAttribute('aria-hidden', 'true');
			document.body.appendChild(this.container);
		}

		if (this.widgetId === null) {
			this.widgetId = turnstile.render(this.container, {
				sitekey: this.siteKey,
				size: 'invisible',
				execution: 'execute',
				retry: 'auto',
				callback: (token: string) => {
					this.pending?.resolve(token);
					this.pending = null;
				},
				'error-callback': (code?: string) => {
					this.pending?.reject(new Error(`Turnstile challenge failed${code ? `: ${code}` : ''}`));
					this.pending = null;
				},
				'expired-callback': () => {
					// Token expired before use — the next getToken() re-executes.
				},
			});
		}

		return new Promise<string>((resolve, reject) => {
			// Only one outstanding challenge at a time; supersede any prior.
			if (this.pending) {
				this.pending.reject(new Error('Turnstile challenge superseded'));
			}
			this.pending = { resolve, reject };
			const id = this.widgetId;
			if (id === null) {
				reject(new Error('Turnstile widget not rendered'));
				this.pending = null;
				return;
			}
			try {
				turnstile.reset(id);
				turnstile.execute(id, { sitekey: this.siteKey });
			} catch (err) {
				this.pending = null;
				reject(err instanceof Error ? err : new Error('Turnstile execute failed'));
			}
		});
	}

	dispose(): void {
		if (this.widgetId !== null && window.turnstile) {
			try {
				window.turnstile.remove(this.widgetId);
			} catch {
				// best-effort
			}
		}
		this.widgetId = null;
		this.pending = null;
		if (this.container) {
			this.container.remove();
			this.container = null;
		}
	}
}
