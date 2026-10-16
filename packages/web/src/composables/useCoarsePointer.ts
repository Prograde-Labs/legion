import { onBeforeUnmount, ref } from 'vue';

/** True when the primary pointer is coarse (touch). SSR-safe: false without window. */
export function useCoarsePointer() {
  const isCoarse = ref(
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
  );
  if (typeof window !== 'undefined') {
    const mq = window.matchMedia('(pointer: coarse)');
    const onChange = (e: MediaQueryListEvent): void => {
      isCoarse.value = e.matches;
    };
    mq.addEventListener('change', onChange);
    onBeforeUnmount(() => mq.removeEventListener('change', onChange));
  }
  return { isCoarse };
}
