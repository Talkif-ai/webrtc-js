import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/emitter.js';

interface Events {
	foo: { value: number };
	bar: { text: string };
}

describe('Emitter', () => {
	it('delivers payloads to subscribed listeners', () => {
		const emitter = new Emitter<Events>();
		const listener = vi.fn();
		emitter.on('foo', listener);
		emitter.emit('foo', { value: 42 });
		expect(listener).toHaveBeenCalledWith({ value: 42 });
	});

	it('unsubscribes via the returned disposer', () => {
		const emitter = new Emitter<Events>();
		const listener = vi.fn();
		const off = emitter.on('foo', listener);
		off();
		emitter.emit('foo', { value: 1 });
		expect(listener).not.toHaveBeenCalled();
	});

	it('does not cross-deliver between events', () => {
		const emitter = new Emitter<Events>();
		const fooListener = vi.fn();
		const barListener = vi.fn();
		emitter.on('foo', fooListener);
		emitter.on('bar', barListener);
		emitter.emit('bar', { text: 'hi' });
		expect(fooListener).not.toHaveBeenCalled();
		expect(barListener).toHaveBeenCalledWith({ text: 'hi' });
	});

	it('tolerates a listener unsubscribing itself mid-emit', () => {
		const emitter = new Emitter<Events>();
		const second = vi.fn();
		const off = emitter.on('foo', () => off());
		emitter.on('foo', second);
		emitter.emit('foo', { value: 1 });
		expect(second).toHaveBeenCalled();
	});
});
