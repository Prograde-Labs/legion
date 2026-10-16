import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import StatusDot from './StatusDot.vue';

describe('StatusDot', () => {
  it('renders active state with cyan class', () => {
    const w = mount(StatusDot, { props: { status: 'active' } });
    expect(w.classes()).toContain('bg-cyan-400');
  });

  it('renders retired state with token class', () => {
    const w = mount(StatusDot, { props: { status: 'retired' } });
    expect(w.classes()).toContain('bg-faint');
  });
});
