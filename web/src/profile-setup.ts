import type { createMessaging } from './messaging/client.ts';

type ProfileSetupClient = Pick<ReturnType<typeof createMessaging>, 'createAccount' | 'updateProfile'>;

/** Blank names keep the existing display fallback without creating kind-0 metadata. */
export async function createProfileWithOptionalName(client: ProfileSetupClient, input: string) {
  await client.createAccount({});
  const name = input.trim();
  if (name) await client.updateProfile({ name });
}
