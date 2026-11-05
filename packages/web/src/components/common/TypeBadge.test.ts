import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TypeBadge from './TypeBadge.vue';

describe('TypeBadge', () => {
  it('styles participant types distinctly', () => {
    expect(mount(TypeBadge, { props: { type: 'agent' } }).classes()).toContain('text-accent');
    expect(mount(TypeBadge, { props: { type: 'user' } }).classes()).toContain('text-success');
  });

  it('maps service and mock types to their tokens', () => {
    expect(mount(TypeBadge, { props: { type: 'service' } }).classes()).toContain('text-warning');
    expect(mount(TypeBadge, { props: { type: 'mock' } }).classes()).toContain('text-muted');
  });

  it('falls back to neutral styling for unknown types', () => {
    const badge = mount(TypeBadge, { props: { type: 'unknown' } });
    expect(badge.classes()).toContain('text-muted');
    expect(badge.classes()).toContain('border-line');
  });
});
