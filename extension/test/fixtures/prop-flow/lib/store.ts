import { create as buildStore } from 'zustand';
import { devtools } from 'zustand/middleware';
import { syncJobs } from './actions';
import { captureNode } from './helpers';

const createCapture = () => (selected: string[], refs: Map<string, HTMLDivElement>) => {
  for (const key of selected) {
    const element = refs.get(key);
    if (element) captureNode(element);
  }
};

const bindings = () => ({
  capture: createCapture(),
  start: async () => { await syncJobs(); },
  retry: async (key: string) => { if (key) await syncJobs(); },
});

export const useJobStore = buildStore()(devtools(() => ({ controls: bindings() })));
export const useJobControls = () => useJobStore(state => state.controls);
