import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ProcessStatusDot from './ProcessStatusDot.vue';
import type { ProcessStatus } from '@legion/types';

const statuses: ProcessStatus[] = ['running', 'starting', 'exited', 'killed', 'abandoned'];

describe('ProcessStatusDot', () => {
  it('renders a span element', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'running' } });
    expect(w.element.tagName).toBe('SPAN');
  });

  it('running: cyan + animate-pulse', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'running' } });
    expect(w.classes()).toContain('bg-cyan-400');
    expect(w.classes()).toContain('animate-pulse');
  });

  it('starting: amber', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'starting' } });
    expect(w.classes()).toContain('bg-amber-400');
  });

  it('exited: slate', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'exited' } });
    expect(w.classes()).toContain('bg-slate-500');
  });

  it('killed: red', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'killed' } });
    expect(w.classes()).toContain('bg-red-400');
  });

  it('abandoned: navy', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'abandoned' } });
    expect(w.classes()).toContain('bg-navy-500');
  });

  it('all statuses render without throwing', () => {
    for (const status of statuses) {
      expect(() => mount(ProcessStatusDot, { props: { status } })).not.toThrow();
    }
  });
});
