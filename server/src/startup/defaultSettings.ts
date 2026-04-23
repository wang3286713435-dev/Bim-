import { ensureRuntimeConfigSettings } from '../services/runtimeConfig.js';

export async function ensureDefaultSettings(): Promise<void> {
  await ensureRuntimeConfigSettings();
  console.log('✅ Ensured default runtime settings');
}
