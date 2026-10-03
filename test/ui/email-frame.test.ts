// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EmailFrame from '../../src/shared/EmailFrame.vue';
import { stubs } from './helpers';

class FakeResizeObserver {
    static last: FakeResizeObserver | null = null;
    observed: Element[] = [];
    disconnected = false;
    constructor(public cb: () => void) { FakeResizeObserver.last = this; }
    observe(el: Element) { this.observed.push(el); }
    disconnect() { this.disconnected = true; }
}

/** A detached document standing in for the iframe's contentDocument. */
function fakeDoc(bodyHeight: number, opts: { padding?: string; noBody?: boolean; noHead?: boolean } = {}) {
    const doc = document.implementation.createHTMLDocument('m');
    if (opts.noHead) doc.head.remove();
    Object.defineProperty(doc.body, 'scrollHeight', { configurable: true, value: bodyHeight });
    doc.body.getBoundingClientRect = () => ({ height: bodyHeight - 0.5 }) as DOMRect;
    const cs = { paddingTop: opts.padding ?? '4px', paddingBottom: opts.padding ?? '6px' };
    Object.defineProperty(doc, 'defaultView', { configurable: true, value: { getComputedStyle: () => cs } });
    if (opts.noBody) Object.defineProperty(doc, 'body', { configurable: true, value: null });
    return doc;
}

function attachDoc(w: ReturnType<typeof mount>, doc: Document | null) {
    Object.defineProperty(w.find('iframe').element, 'contentDocument', { configurable: true, get: () => doc });
}

const style = (w: ReturnType<typeof mount>) => w.find('iframe').attributes('style') ?? '';

describe('EmailFrame', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
        vi.stubGlobal('ResizeObserver', FakeResizeObserver);
        FakeResizeObserver.last = null;
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('loads hidden with a spinner, then reveals at the measured height', async () => {
        const w = mount(EmailFrame, { props: { src: '/body', minHeight: 100 }, global: { stubs } });
        expect(w.find('.v-progress-circular').exists()).toBe(true);
        expect(w.find('.email-frame-host').attributes('style')).toContain('min-height: 100px');
        expect(style(w)).toContain('6000px');
        expect(style(w)).toContain('visibility: hidden');
        expect(w.find('iframe').attributes('src')).toBe('/body');

        const doc = fakeDoc(500);
        attachDoc(w, doc);
        await w.find('iframe').trigger('load');
        // 500 + 10 padding + 2
        expect(style(w)).toContain('height: 512px');
        expect(w.find('.v-progress-circular').exists()).toBe(false);
        expect(doc.querySelector('base')?.getAttribute('target')).toBe('_blank');

        // later reflow is applied
        Object.defineProperty(doc.body, 'scrollHeight', { configurable: true, value: 800 });
        FakeResizeObserver.last!.cb();
        await w.vm.$nextTick();
        expect(style(w)).toContain('height: 812px');
        expect(FakeResizeObserver.last!.observed).toEqual([doc.body]);
    });

    it('a second load event re-measures without a pending timer', async () => {
        const w = mount(EmailFrame, { props: { src: '/b' }, global: { stubs } });
        const doc = fakeDoc(200);
        attachDoc(w, doc);
        await w.find('iframe').trigger('load');
        Object.defineProperty(doc.body, 'scrollHeight', { configurable: true, value: 300 });
        await w.find('iframe').trigger('load');
        expect(style(w)).toContain('height: 312px');
    });

    it('does not add a second <base target> and handles missing padding values', async () => {
        const w = mount(EmailFrame, { props: { src: '/b' }, global: { stubs } });
        const doc = fakeDoc(300, { padding: '' });
        const base = doc.createElement('base');
        base.target = '_self';
        doc.head.append(base);
        attachDoc(w, doc);
        await w.find('iframe').trigger('load');
        expect(doc.querySelectorAll('base')).toHaveLength(1);
        expect(style(w)).toContain('height: 302px');
    });

    it('never goes below the floor', async () => {
        const w = mount(EmailFrame, { props: { srcdoc: '<p>x</p>', minHeight: 10 }, global: { stubs } });
        expect(w.find('iframe').attributes('srcdoc')).toBe('<p>x</p>');
        attachDoc(w, fakeDoc(5));
        await w.find('iframe').trigger('load');
        expect(style(w)).toContain('height: 60px');
    });

    it('falls back to the floor when the document cannot be measured', async () => {
        const w = mount(EmailFrame, { props: {}, global: { stubs } });
        expect(w.find('iframe').attributes('srcdoc')).toBe('');
        attachDoc(w, null);
        await w.find('iframe').trigger('load');
        expect(style(w)).toContain('height: 160px');
        expect(FakeResizeObserver.last).toBeNull();
    });

    it('observes nothing when the document has no body / no head', async () => {
        const w = mount(EmailFrame, { props: { src: '/x', minHeight: 'abc' as any }, global: { stubs } });
        attachDoc(w, fakeDoc(100, { noBody: true, noHead: true }));
        await w.find('iframe').trigger('load');
        expect(style(w)).toContain('height: 160px');
        expect(FakeResizeObserver.last!.observed).toEqual([]);
    });

    it('works without ResizeObserver', async () => {
        vi.stubGlobal('ResizeObserver', undefined);
        delete (window as any).ResizeObserver;
        const w = mount(EmailFrame, { props: { src: '/x' }, global: { stubs } });
        attachDoc(w, fakeDoc(400));
        await w.find('iframe').trigger('load');
        expect(style(w)).toContain('height: 412px');
    });

    it('reveals after the fallback timeout if load never fires', async () => {
        const w = mount(EmailFrame, { props: { src: '/x' }, global: { stubs } });
        attachDoc(w, null);
        vi.advanceTimersByTime(10_000);
        await w.vm.$nextTick();
        expect(style(w)).toContain('height: 160px');
    });

    it('hides and re-arms when the source changes, keeping the last height while unmeasurable', async () => {
        const w = mount(EmailFrame, { props: { src: '/a' }, global: { stubs } });
        attachDoc(w, fakeDoc(700));
        await w.find('iframe').trigger('load');
        const ro = FakeResizeObserver.last!;
        expect(style(w)).toContain('height: 712px');

        await w.setProps({ src: '/b' });
        expect(ro.disconnected).toBe(true);
        expect(style(w)).toContain('visibility: hidden');
        // a resize while hidden is ignored
        ro.cb();
        await w.setProps({ src: '/c' }); // re-arm clears the previous timer
        attachDoc(w, fakeDoc(0, { noBody: true }));
        vi.advanceTimersByTime(10_000);
        await w.vm.$nextTick();
        expect(style(w)).toContain('height: 712px');
    });

    it('clears the pending timer on unmount', () => {
        const clear = vi.spyOn(window, 'clearTimeout');
        const w = mount(EmailFrame, { props: { src: '/a' }, global: { stubs } });
        w.unmount();
        expect(clear).toHaveBeenCalled();
    });

    it('unmount after reveal has no timer to clear', async () => {
        const w = mount(EmailFrame, { props: { src: '/a' }, global: { stubs } });
        attachDoc(w, fakeDoc(100));
        await w.find('iframe').trigger('load');
        const clear = vi.spyOn(window, 'clearTimeout');
        w.unmount();
        expect(clear).not.toHaveBeenCalled();
        expect(FakeResizeObserver.last!.disconnected).toBe(true);
    });
});
