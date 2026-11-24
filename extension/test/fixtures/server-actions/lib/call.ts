import * as actions from '../app/actions';

export async function go() {
  await actions.signOut();
}

export function register(flag: boolean) {
  return flag ? actions.save : actions.discard;
}

export type Save = typeof actions.save;

import runDefault, { plainHelper as fromActionModule } from '../app/actions';
import { reexported as implementation, plainHelper } from './reex';
const originalCalls = () => [implementation(), plainHelper()];
const actionCalls = () => [actions.reexported(), fromActionModule(), runDefault(), actions.picked()];
const localExportCall = () => actions.helper();
