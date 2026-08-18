import type { RpcRouter } from '@main/rpc';
import { createEventEmitter, type EmitterAdapter } from '@shared/lib/ipc/events';
import { createRPCClient } from '@shared/lib/ipc/rpc';

/** Typed client for every `rpc.<namespace>.<procedure>()` the main process exposes. */
export const rpc = createRPCClient<RpcRouter>(window.electronAPI.invoke);

function createRendererAdapter(): EmitterAdapter {
  return {
    emit: (eventName: string, data: unknown, topic?: string) => {
      const channel = topic ? `${eventName}.${topic}` : eventName;
      window.electronAPI.eventSend(channel, data);
    },
    on: (eventName: string, cb: (data: unknown) => void, topic?: string) => {
      const channel = topic ? `${eventName}.${topic}` : eventName;
      return window.electronAPI.eventOn(channel, cb);
    },
  };
}

/** Typed client for every event `defineEvent()` describes, mirroring main's `events`. */
export const events = createEventEmitter(createRendererAdapter());
