import { SignInRows } from '@renderer/features/pages/sign-in';
import { settingsRow } from '../settings-pages';
import { SettingsBlock } from '../settings-row';

/** Settings › Sign-ins: `SignInRows` (`features/pages/sign-in.tsx`), unchanged in behavior. */
export function SignInsPage() {
  return (
    <SettingsBlock id={settingsRow('browser-sign-ins')!.id}>
      <SignInRows />
    </SettingsBlock>
  );
}
