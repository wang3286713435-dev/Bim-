import type { Server } from 'socket.io';
import { runHotspotCheck } from './hotspotChecker.js';

type QueueState = {
  running: boolean;
  lastStartedAt?: Date;
  lastFinishedAt?: Date;
  lastError?: string;
};

const state: QueueState = {
  running: false
};

export function getHotspotCheckQueueState(): QueueState {
  return { ...state };
}

export function startHotspotCheckInBackground(io: Server, triggerType: 'manual' | 'scheduled' = 'manual'): {
  accepted: boolean;
  message: string;
} {
  if (state.running) {
    return {
      accepted: false,
      message: 'Hotspot check is already running'
    };
  }

  state.running = true;
  state.lastStartedAt = new Date();
  state.lastError = undefined;

  void runHotspotCheck(io, triggerType)
    .then(() => {
      state.lastFinishedAt = new Date();
    })
    .catch(error => {
      state.lastError = error instanceof Error ? error.message : String(error);
      console.error('Background hotspot check failed:', error);
    })
    .finally(() => {
      state.running = false;
    });

  return {
    accepted: true,
    message: 'Hotspot check queued'
  };
}
