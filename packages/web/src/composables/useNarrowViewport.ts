import { onBeforeUnmount, ref } from 'vue';

/** Tailwind `md` breakpoint boundary: narrow is anything below 768px. */
const QUERY = '(max-width: 767px)';

/** True when the viewport is below the md breakpoint (single-pane layouts). SSR-safe: false without window. */
export function useNarrowViewport() {
  const isNarrow = ref(typeof window !== 'undefined' && window.matchMedia(QUERY).matches);
  if (typeof window !== 'undefined') {
    const mq = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent): void => {
      isNarrow.value = e.matches;
    };
    mq.addEventListener('change', onChange);
    onBeforeUnmount(() => mq.removeEventListener('change', onChange));
  }
  return { isNarrow };
}
