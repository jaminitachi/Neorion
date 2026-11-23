export function ServerPanel() {
  async function inline() { 'use server'; }
  return <form action={inline} />;
}

export function OtherPanel() {
  async function inline() { 'use server'; }
  const onlyInline = async () => { 'use server'; };
  return <form action={inline}><button formAction={onlyInline} /></form>;
}
