import { Router } from 'express';
import { prisma } from '../db.js';
import {
  RUNTIME_SETTING_KEYS,
  TENDER_SOURCE_IDS,
  clearRuntimeConfigCache,
  getRuntimeConfig,
  normalizeRuntimeConfig,
  runtimeConfigToSettings
} from '../services/runtimeConfig.js';
import { TENDER_SOURCE_ADAPTERS, getTenderSourceRuntimeSnapshot } from '../services/tenderSourceRegistry.js';

const router = Router();

router.get('/runtime', async (req, res) => {
  try {
    const config = await getRuntimeConfig(true);
    res.json(config);
  } catch (error) {
    console.error('Error fetching runtime config:', error);
    res.status(500).json({ error: 'Failed to fetch runtime config' });
  }
});

router.put('/runtime', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid runtime config format' });
    }

    const payloadRecord = payload as Record<string, unknown>;
    const current = await getRuntimeConfig(true);
    const next = normalizeRuntimeConfig({
      ...current,
      ...payloadRecord,
      tenderSources: Array.isArray(payloadRecord.tenderSources)
        ? payloadRecord.tenderSources.filter((source: unknown): source is typeof TENDER_SOURCE_IDS[number] => typeof source === 'string' && TENDER_SOURCE_IDS.includes(source as typeof TENDER_SOURCE_IDS[number]))
        : current.tenderSources,
      lowValueExcludeKeywords: Array.isArray(payloadRecord.lowValueExcludeKeywords)
        ? payloadRecord.lowValueExcludeKeywords as string[]
        : current.lowValueExcludeKeywords,
      lowValueIncludeKeywords: Array.isArray(payloadRecord.lowValueIncludeKeywords)
        ? payloadRecord.lowValueIncludeKeywords as string[]
        : current.lowValueIncludeKeywords
    });

    const settingsMap = runtimeConfigToSettings(next);
    await Promise.all(RUNTIME_SETTING_KEYS.map(key =>
      prisma.setting.upsert({
        where: { key },
        update: { value: settingsMap[key] },
        create: { key, value: settingsMap[key] }
      })
    ));

    clearRuntimeConfigCache();
    const config = await getRuntimeConfig(true);
    res.json({ message: 'Runtime config updated', config });
  } catch (error) {
    console.error('Error updating runtime config:', error);
    res.status(500).json({ error: 'Failed to update runtime config' });
  }
});

router.get('/sources', async (req, res) => {
  try {
    const runtimeConfig = await getRuntimeConfig(true);
    const enabled = new Set(runtimeConfig.tenderSources);

    res.json({
      data: TENDER_SOURCE_ADAPTERS.map(source => ({
        id: source.id,
        name: source.name,
        platform: source.platform,
        homepage: source.homepage,
        priority: source.priority,
        enabled: enabled.has(source.id),
        runtime: getTenderSourceRuntimeSnapshot(source.id)
      }))
    });
  } catch (error) {
    console.error('Error fetching source settings:', error);
    res.status(500).json({ error: 'Failed to fetch source settings' });
  }
});

router.put('/sources', async (req, res) => {
  try {
    const sources = req.body?.sources;
    if (!Array.isArray(sources)) {
      return res.status(400).json({ error: 'sources must be an array' });
    }

    const normalized = [...new Set(sources.filter((source: unknown) => typeof source === 'string' && TENDER_SOURCE_IDS.includes(source as typeof TENDER_SOURCE_IDS[number])))] as string[];
    if (normalized.length === 0) {
      return res.status(400).json({ error: 'At least one valid source is required' });
    }

    await prisma.setting.upsert({
      where: { key: 'TENDER_SOURCES' },
      update: { value: normalized.join(',') },
      create: { key: 'TENDER_SOURCES', value: normalized.join(',') }
    });

    clearRuntimeConfigCache();
    const runtimeConfig = await getRuntimeConfig(true);
    res.json({ message: 'Sources updated', tenderSources: runtimeConfig.tenderSources });
  } catch (error) {
    console.error('Error updating sources:', error);
    res.status(500).json({ error: 'Failed to update sources' });
  }
});

// 获取所有设置
router.get('/', async (req, res) => {
  try {
    const settings = await prisma.setting.findMany();
    const settingsMap = settings.reduce((acc: Record<string, string>, item: { key: string; value: string }) => {
      acc[item.key] = item.value;
      return acc;
    }, {} as Record<string, string>);

    res.json(settingsMap);
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// 更新设置
router.put('/', async (req, res) => {
  try {
    const settings = req.body;

    if (typeof settings !== 'object') {
      return res.status(400).json({ error: 'Invalid settings format' });
    }

    const updates = Object.entries(settings).map(([key, value]) => 
      prisma.setting.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) }
      })
    );

    await Promise.all(updates);
    clearRuntimeConfigCache();

    res.json({ message: 'Settings updated' });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// 获取单个设置
router.get('/:key', async (req, res) => {
  try {
    const setting = await prisma.setting.findUnique({
      where: { key: req.params.key }
    });

    if (!setting) {
      return res.status(404).json({ error: 'Setting not found' });
    }

    res.json({ key: setting.key, value: setting.value });
  } catch (error) {
    console.error('Error fetching setting:', error);
    res.status(500).json({ error: 'Failed to fetch setting' });
  }
});

// 更新单个设置
router.put('/:key', async (req, res) => {
  try {
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }

    const setting = await prisma.setting.upsert({
      where: { key: req.params.key },
      update: { value: String(value) },
      create: { key: req.params.key, value: String(value) }
    });
    clearRuntimeConfigCache();

    res.json(setting);
  } catch (error) {
    console.error('Error updating setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

export default router;
