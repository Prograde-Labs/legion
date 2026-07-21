import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SkillsSelector from './SkillsSelector.vue';

const skills = [
  {
    name: 'alpha',
    description: 'Alpha workflow',
    scope: 'project',
    location: '/p/alpha/SKILL.md',
    baseDirectory: '/p/alpha',
  },
  {
    name: 'beta',
    description: 'Beta workflow',
    scope: 'user',
    location: '/u/beta/SKILL.md',
    baseDirectory: '/u/beta',
  },
];

describe('SkillsSelector', () => {
  it('filters by name and description and adds one skill once', async () => {
    const wrapper = mount(SkillsSelector, { props: { modelValue: [], skills } });
    await wrapper.get('[data-skill-search]').setValue('Beta workflow');
    await wrapper.get('[data-skill-option="beta"]').trigger('click');
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([['beta']]);
    expect(wrapper.find('[data-skill-option="alpha"]').exists()).toBe(false);
  });

  it('shows scope and removes selected skills', async () => {
    const wrapper = mount(SkillsSelector, { props: { modelValue: ['alpha'], skills } });
    expect(wrapper.get('[data-selected-skill="alpha"]').text()).toContain('project');
    await wrapper.get('[data-remove-skill="alpha"]').trigger('click');
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([[]]);
  });
});
