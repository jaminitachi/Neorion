'use client';

import { useActionState } from 'react';
import { useFormState } from 'react-dom';
import { submit, save as store, discard, signOut, unused } from './actions';

function Button({ run }) { return <button formAction={run} />; }

export default function Page({ edit }) {
  useActionState(edit ? store : discard, undefined);
  useFormState(discard, undefined);
  return <form action={submit}>
    <button formAction={store} />
    <Button run={signOut} />
  </form>;
}
