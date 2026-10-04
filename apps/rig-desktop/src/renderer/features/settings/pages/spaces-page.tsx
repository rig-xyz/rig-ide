import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import type { RigSettings } from '@shared/rig/settings';
import { DEFAULT_ROOM_SEES, ROOM_SEES_LABEL, ROOM_SEES_LEVELS, ROOM_SEES_TOOLTIP, type RoomSees } from '@shared/spaces/room-sees';
import { settingsRow } from '../settings-pages';
import { SettingsRow, SettingsRows, SettingsSegmented, type SegmentOption } from '../settings-row';

const ROOM_SEES_OPTIONS: readonly SegmentOption<RoomSees>[] = ROOM_SEES_LEVELS.map((id) => ({
  id,
  label: ROOM_SEES_LABEL[id],
}));

const QUERY_KEY = ['rig', 'settings', 'spacesRoomSeesDefault'];

/**
 * Settings › Spaces: how much of your agent's work others see in a space
 * you haven't set on its own (`spacesRoomSeesDefault`). A space's own pick
 * (`spacesRoomSees`, from the agent menu in its composer) still wins.
 */
export function SpacesPage() {
  const row = settingsRow('room-sees-default')!;
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: QUERY_KEY, queryFn: () => rpc.rig.settings.get() });
  const level = data?.spacesRoomSeesDefault ?? DEFAULT_ROOM_SEES;

  const change = (next: RoomSees) => {
    queryClient.setQueryData(QUERY_KEY, (old: RigSettings | undefined) =>
      old ? { ...old, spacesRoomSeesDefault: next } : old
    );
    void rpc.rig.settings.set({ spacesRoomSeesDefault: next }).then(() => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    });
  };

  return (
    <SettingsRows>
      <SettingsRow
        id={row.id}
        label={<span title={ROOM_SEES_TOOLTIP}>{row.label}</span>}
        description={row.description}
        control={<SettingsSegmented label={row.label} value={level} options={ROOM_SEES_OPTIONS} onChange={change} />}
      />
    </SettingsRows>
  );
}
