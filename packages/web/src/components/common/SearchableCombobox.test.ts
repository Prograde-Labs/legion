import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SearchableCombobox from './SearchableCombobox.vue';

const options = [
  { value: 'agent-1', label: 'Atlas' },
  { value: 'agent-2', label: 'Research Bot' },
  { value: 'agent-3', label: 'Planner' },
];

describe('SearchableCombobox', () => {
  it('renders the placeholder when no value is selected', () => {
    const wrapper = mount(SearchableCombobox, { props: { options, placeholder: 'Select agent...' } });
    expect(wrapper.find('input').attributes('placeholder')).toBe('Select agent...');
  });

  it('shows all options when input is focused', async () => {
    const wrapper = mount(SearchableCombobox, { props: { options, placeholder: 'Select agent...' } });
    await wrapper.find('input').trigger('focus');
    expect(wrapper.findAll('[data-option]')).toHaveLength(3);
  });

  it('filters options by input text', async () => {
    const wrapper = mount(SearchableCombobox, { props: { options, placeholder: 'Select agent...' } });
    await wrapper.find('input').trigger('focus');
    await wrapper.find('input').setValue('atlas');
    const visibleOptions = wrapper.findAll('[data-option]');
    expect(visibleOptions).toHaveLength(1);
    expect(visibleOptions[0].text()).toContain('Atlas');
  });

  it('emits select with value when option is clicked', async () => {
    const wrapper = mount(SearchableCombobox, { props: { options, placeholder: 'Select agent...' } });
    await wrapper.find('input').trigger('focus');
    await wrapper.findAll('[data-option]')[0].trigger('mousedown');
    expect(wrapper.emitted('select')).toEqual([['agent-1']]);
  });

  it('closes dropdown after selection', async () => {
    const wrapper = mount(SearchableCombobox, { props: { options, placeholder: 'Select agent...' } });
    await wrapper.find('input').trigger('focus');
    await wrapper.findAll('[data-option]')[0].trigger('mousedown');
    expect(wrapper.findAll('[data-option]')).toHaveLength(0);
  });
});
