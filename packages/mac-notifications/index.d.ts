export type MacNotificationStatus =
  | 'authorized'
  | 'denied'
  | 'notDetermined'
  | 'provisional'
  | 'unknown'
  | 'unsupported';

export function getStatus(): MacNotificationStatus;
export function request(): void;
/** This process's bundle id (what System Settings › Notifications lists it under), or null. */
export function bundleId(): string | null;
