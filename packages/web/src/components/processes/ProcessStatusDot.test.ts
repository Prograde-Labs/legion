import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ProcessStatusDot from './ProcessStatusDot.vue';
import type { ProcessStatus } from '@legion-collective/types';

const statuses: ProcessStatus[] = ['running', 'starting', 'exited', 'killed', 'abandoned'];

describe('ProcessStatusDot', () => {
  it('renders a span element', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'running' } });
    expect(w.element.tagName).toBe('SPAN');
  });

  it('running: accent + animate-pulse', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'running' } });
    expect(w.classes()).toContain('bg-accent');
    expect(w.classes()).toContain('animate-pulse');
  });

  it('starting: warning', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'starting' } });
    expect(w.classes()).toContain('bg-warning');
  });

  it('exited: faint', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'exited' } });
    expect(w.classes()).toContain('bg-faint');
  });

  it('killed: danger', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'killed' } });
    expect(w.classes()).toContain('bg-danger');
  });

  it('abandoned: faint', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'abandoned' } });
    expect(w.classes()).toContain('bg-faint');
  });

  it('all statuses render without throwing', () => {
    for (const status of statuses) {
      expect(() => mount(ProcessStatusDot, { props: { status } })).not.toThrow();
    }
  });
});
