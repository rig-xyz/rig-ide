import { type IpcMain } from 'electron';
import { log } from './logger';

/** Calls made several times a second (a page's pins following it, comment mode's hover): their results aren't logged, only their errors. */
const QUIET_CHANNELS: ReadonlySet<string> = new Set(['rig.pages.locate', 'rig.pages.peek']);

export function withRpcLogging(target: IpcMain): IpcMain {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop !== 'handle') return Reflect.get(obj, prop, receiver);
      return (channel: string, handler: (...a: unknown[]) => unknown) =>
        obj.handle(channel, async (event, ...args: unknown[]) => {
          try {
            const result = await handler(event, ...args);
            if (!QUIET_CHANNELS.has(channel)) log.debug('rpc result', { channel, args, result });
            return result;
          } catch (err) {
            log.error('rpc error', { channel, args, err });
            throw err;
          }
        });
    },
  });
}
