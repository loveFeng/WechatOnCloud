import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Docker from 'dockerode';
import {
  docker,
  ensureAddonNetwork,
  instanceRuntime,
  PGID,
  PUID,
  registerAddonLifecycle,
  TZ,
  type RuntimeState,
} from './docker.js';
import { appendInstanceLog, appendPanelLog } from './logs.js';
import { instanceAppType, listInstances, type InstalledAddon, type Instance } from './store.js';

export type PanelAction = 'refresh-article' | 'instance-status' | 'restart-wechat';

export interface AddonMountSpec {
  type: 'instance-data' | 'output';
  target: string;
  mode: 'ro' | 'rw';
}

export interface AddonOptionProperty {
  type: 'string' | 'boolean';
  title: string;
  description?: string;
  default?: string | boolean;
  placeholder?: string;
}

export interface AddonManifest {
  apiVersion: 'woc.addon/v1';
  id: string;
  name: string;
  description: string;
  version: string;
  image: string;
  supportedApps?: string[];
  mounts: AddonMountSpec[];
  options?: {
    type: 'object';
    properties: Record<string, AddonOptionProperty>;
    required?: string[];
  };
  requires?: {
    panelActions?: PanelAction[];
  };
  healthcheck?: {
    type: 'http';
    port: number;
    path: string;
  };
  mcp?: {
    port: number;
    path: string;
  };
  resources?: {
    memory?: string;
  };
}

export interface AddonRuntimeStatus {
  id: string;
  name: string;
  runtime: RuntimeState;
  containerName: string;
  state?: string; // idle | running | error
  lastRun?: string;
  lastError?: string; // STALE_SESSION_KEY | LOGIN_REQUIRED | ...
  lastErrorDetail?: string;
  lastSkipped?: string; // SCHEDULED_SKIPPED_BUSY
  lastSkippedAt?: string;
  updatedAt?: string;
  accounts?: string[];
}

const ADDONS_DIR = process.env.PANEL_ADDONS_DIR || '/data/addons';
const ADDON_IMAGE_PREFIX = (process.env.WOC_ADDON_IMAGE_PREFIX || '').trim().replace(/\/+$/, '');
const ADDON_OUTPUT_ROOT = (process.env.WOC_ADDON_OUTPUT_ROOT || '').trim().replace(/[\\/]+$/, '');
const PANEL_PORT = Number(process.env.PORT || 8080);
const SAFE_UID = /^\d+$/.test(PUID) ? PUID : '1000';
const SAFE_GID = /^\d+$/.test(PGID) ? PGID : '1000';
const ADDON_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const PANEL_ACTIONS = new Set<PanelAction>(['refresh-article', 'instance-status', 'restart-wechat']);

const BUILTIN_MANIFESTS: AddonManifest[] = [
  {
    apiVersion: 'woc.addon/v1',
    id: 'wxdown-archiver',
    name: '公众号素材归档',
    description: '定时增量抓取关注公众号文章，导出 Markdown/HTML/20 列统计 CSV 与图片，并提供 AI MCP 接口',
    version: '1.0.0',
    image: process.env.WOC_WXDOWN_IMAGE || 'wxdown/wxdown-d:1.0.0',
    supportedApps: ['wechat'],
    mounts: [
      { type: 'instance-data', target: '/config', mode: 'ro' },
      { type: 'output', target: '/out', mode: 'rw' },
    ],
    options: {
      type: 'object',
      properties: {
        accounts: {
          type: 'string',
          title: '跟踪公众号（__biz，逗号或换行分隔）',
          placeholder: '如 MzAwMDAwMDAwMQ==（可留空，仅开启 MCP 按需归档）',
          default: '',
        },
        schedule: {
          type: 'string',
          title: '每日定时计划（HH:MM 或 cron）',
          placeholder: '03:30',
          default: '03:30',
        },
        formats: {
          type: 'string',
          title: '导出格式',
          placeholder: 'md,html',
          default: 'md,html',
        },
      },
    },
    requires: {
      panelActions: ['refresh-article', 'instance-status', 'restart-wechat'],
    },
    healthcheck: {
      type: 'http',
      port: 8080,
      path: '/healthz',
    },
    mcp: {
      port: 4545,
      path: '/mcp',
    },
    resources: {
      memory: '256m',
    },
  },
];

function resolveAddonImage(rawImage: string): string {
  if (!ADDON_IMAGE_PREFIX) return rawImage;
  const slash = rawImage.indexOf('/');
  // 已有显式 registry 域名（含 . 或 :）时直接替换前缀，否则拼接前缀
  if (slash > 0 && /[.:]/.test(rawImage.slice(0, slash))) {
    return `${ADDON_IMAGE_PREFIX}/${rawImage.slice(slash + 1)}`;
  }
  return `${ADDON_IMAGE_PREFIX}/${rawImage}`;
}

function validateManifest(raw: any): AddonManifest | null {
  if (!raw || raw.apiVersion !== 'woc.addon/v1') return null;
  if (typeof raw.id !== 'string' || !ADDON_ID_RE.test(raw.id)) return null;
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
  if (typeof raw.image !== 'string' || !raw.image.trim() || /:latest$/i.test(raw.image.trim())) {
    // §9 / §15.5：插件镜像必须带固定版本 tag，拒绝 :latest
    return null;
  }
  if (!Array.isArray(raw.mounts) || raw.mounts.length === 0) return null;
  for (const m of raw.mounts) {
    if (!m || typeof m.target !== 'string' || !m.target.startsWith('/') || m.target.includes('..')) return null;
    if (m.type === 'instance-data' && m.mode !== 'ro') return null;
    if (m.type === 'output' && m.mode !== 'rw') return null;
    if (m.type !== 'instance-data' && m.type !== 'output') return null;
  }
  if (raw.requires?.panelActions) {
    if (!Array.isArray(raw.requires.panelActions)) return null;
    for (const act of raw.requires.panelActions) {
      if (!PANEL_ACTIONS.has(act)) return null;
    }
  }
  return raw as AddonManifest;
}

export function loadAddonCatalog(): Map<string, AddonManifest> {
  const map = new Map<string, AddonManifest>();
  for (const m of BUILTIN_MANIFESTS) {
    map.set(m.id, { ...m, image: resolveAddonImage(m.image) });
  }
  if (existsSync(ADDONS_DIR)) {
    try {
      for (const f of readdirSync(ADDONS_DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(readFileSync(join(ADDONS_DIR, f), 'utf8'));
          const valid = validateManifest(parsed);
          if (valid) {
            map.set(valid.id, { ...valid, image: resolveAddonImage(valid.image) });
          } else {
            appendPanelLog('WARN', `[addon] 忽略不合法的插件清单 ${f}`);
          }
        } catch (e: any) {
          appendPanelLog('WARN', `[addon] 解析插件清单 ${f} 失败：${e?.message || e}`);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return map;
}

export function listCatalogAddons(): AddonManifest[] {
  return [...loadAddonCatalog().values()];
}

export function getAddonManifest(id: string): AddonManifest | undefined {
  return loadAddonCatalog().get(id);
}

export function addonContainerName(instId: string, addonId: string): string {
  return `woc-addon-${instId}-${addonId}`;
}

export function addonOutputVolumeName(instId: string): string {
  return `woc-addon-out-${instId}`;
}

function parseMemoryBytes(mem?: string): number {
  if (!mem) return 256 * 1024 * 1024;
  const m = mem.trim().match(/^(\d+)\s*([kmg])b?$/i);
  if (!m) return 256 * 1024 * 1024;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : 1024;
  return Math.max(64 * 1024 * 1024, n * mult);
}

// 校验并归一化前端传入的实例插件配置列表
export function sanitizeInstalledAddons(raw: unknown, appType = 'wechat'): InstalledAddon[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    const err: any = new Error('addons 参数必须为数组');
    err.statusCode = 400;
    throw err;
  }
  const catalog = loadAddonCatalog();
  const seen = new Set<string>();
  const out: InstalledAddon[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = String((item as any).id || '').trim();
    if (!id) continue;
    const manifest = catalog.get(id);
    if (!manifest) {
      const err: any = new Error(`未知插件：${id}`);
      err.statusCode = 400;
      throw err;
    }
    if ((item as any).enabled === false) continue;
    if (manifest.supportedApps?.length && !manifest.supportedApps.includes(appType)) {
      const err: any = new Error(`插件「${manifest.name}」仅支持 ${manifest.supportedApps.join('/')} 实例`);
      err.statusCode = 400;
      throw err;
    }
    if (seen.has(id)) continue;
    seen.add(id);

    const rawOpts = (item as any).options;
    const options: Record<string, unknown> = {};
    if (rawOpts && typeof rawOpts === 'object' && !Array.isArray(rawOpts)) {
      for (const [k, v] of Object.entries(rawOpts)) {
        if (typeof v === 'string') options[k] = v.trim().slice(0, 2000);
        else if (typeof v === 'boolean' || typeof v === 'number') options[k] = v;
        else if (Array.isArray(v)) options[k] = v.slice(0, 50);
      }
    }
    out.push({ id, enabled: true, options });
  }
  return out;
}

// 将持久化的插件 options 序列化为传给容器的 WOC_ADDON_OPTIONS 字符串
function buildAddonOptionsEnv(addonId: string, rawOptions?: Record<string, unknown>): string {
  const opts: Record<string, unknown> = { ...(rawOptions || {}) };
  if (addonId === 'wxdown-archiver') {
    let acctList: unknown[] = [];
    if (typeof opts.accounts === 'string') {
      acctList = opts.accounts
        .split(/[,，;\r\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (Array.isArray(opts.accounts)) {
      acctList = opts.accounts.filter(Boolean);
    }
    if (typeof opts.schedule !== 'string' || !opts.schedule.trim()) {
      opts.schedule = '03:30';
    }
    if (typeof opts.formats !== 'string' || !opts.formats.trim()) {
      opts.formats = 'md,html';
    }
    // 未填跟踪账号时传空串，使 wxdownd 进入待命/MCP 模式而不报“未配置 accounts”退出
    if (acctList.length === 0) {
      return '';
    }
    opts.accounts = acctList;
    return JSON.stringify(opts);
  }
  return Object.keys(opts).length ? JSON.stringify(opts) : '';
}

async function ensureAddonImage(image: string, instId: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return; // 本地已有镜像（如自构建的 wxdown/wxdown-d:1.0.0），直接复用不联网
  } catch {
    /* 本地不存在，尝试拉取 */
  }
  appendInstanceLog(instId, `[addon] 正在拉取插件镜像 ${image}`);
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: any, stream: any) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (doneErr: any) => (doneErr ? reject(doneErr) : resolve()));
    });
  });
}

async function prepareOutputBind(inst: Instance, image: string): Promise<string> {
  if (ADDON_OUTPUT_ROOT) {
    const hostDir = `${ADDON_OUTPUT_ROOT}/${inst.id}`;
    // 确保宿主绑定目录对 1000:1000 可写（兼容 Linux/NAS root 自动建目录场景，Windows Docker Desktop 静默放行）
    const init = await docker.createContainer({
      Image: image,
      Entrypoint: ['sh', '-c'],
      Cmd: [`mkdir -p /out && { chown ${SAFE_UID}:${SAFE_GID} /out 2>/dev/null || chmod 0777 /out 2>/dev/null || true; }`],
      User: '0:0',
      Labels: { 'woc.helper': 'addon-output-init' },
      HostConfig: {
        Binds: [`${hostDir}:/out`],
        NetworkMode: 'none',
      },
    } as any);
    try {
      await init.start();
      await init.wait();
    } finally {
      await init.remove({ force: true }).catch(() => {});
    }
    return `${hostDir}:/out`;
  }

  const volName = addonOutputVolumeName(inst.id);
  try {
    await docker.getVolume(volName).inspect();
  } catch {
    await docker.createVolume({
      Name: volName,
      Labels: {
        'com.wechatoncloud.role': 'addon-output',
        'com.wechatoncloud.addon.instance': inst.id,
      },
    } as any);
  }
  return `${volName}:/out`;
}

// 同一实例的 sidecar 协调串行执行，防止并发勾选/重启撞车
const addonChains = new Map<string, Promise<unknown>>();
function withAddonLock<T>(instId: string, fn: () => Promise<T>): Promise<T> {
  const run = (addonChains.get(instId) || Promise.resolve()).then(fn, fn);
  addonChains.set(instId, run.catch(() => undefined));
  return run;
}

async function stopAndRemoveContainer(c: Docker.Container): Promise<void> {
  try {
    await c.stop({ t: 10 });
  } catch {
    /* ignore */
  }
  try {
    await c.remove({ force: true });
  } catch {
    /* ignore */
  }
}
export function ensureAddons(inst: Instance): Promise<void> {
  return withAddonLock(inst.id, () => ensureAddonsNow(inst));
}

async function ensureAddonsNow(inst: Instance): Promise<void> {
  const catalog = loadAddonCatalog();
  const enabled = (inst.addons || []).filter((a) => a && a.enabled !== false && catalog.has(a.id));
  const enabledIds = new Set(enabled.map((a) => a.id));

  // 1) 清理该实例下已被取消勾选的旧 sidecar 容器（保留输出卷数据）
  const existingList = await docker
    .listContainers({
      all: true,
      filters: { label: [`com.wechatoncloud.addon.instance=${inst.id}`] },
    })
    .catch(() => []);

  for (const cInfo of existingList) {
    const aid = cInfo.Labels?.['com.wechatoncloud.addon.id'] || '';
    if (!enabledIds.has(aid)) {
      await stopAndRemoveContainer(docker.getContainer(cInfo.Id));
      appendInstanceLog(inst.id, `[addon] 已停止并移除插件容器 ${aid || cInfo.Id.slice(0, 12)}`);
    }
  }

  if (enabled.length === 0) return;

  // 若主实例容器未运行，暂不拉起 sidecar（等主实例启动时由钩子自动拉起）
  if ((await instanceRuntime(inst)) !== 'running') return;

  const addonNet = await ensureAddonNetwork();
  if (!addonNet) {
    throw new Error('插件专用网络 woc-addons 不可用，无法安全启动插件');
  }

  for (const item of enabled) {
    const manifest = catalog.get(item.id)!;
    await ensureAddonImage(manifest.image, inst.id);
    const outBind = await prepareOutputBind(inst, manifest.image);

    // 严格按白名单组装挂载：微信数据卷强制 :ro，绝不挂载 docker.sock
    const binds: string[] = [];
    for (const m of manifest.mounts) {
      if (m.type === 'instance-data') {
        binds.push(`${inst.volumeName}:${m.target}:ro`);
      } else if (m.type === 'output') {
        binds.push(outBind.replace(/:\/out$/, `:${m.target}`));
      }
    }

    const optionsJson = buildAddonOptionsEnv(item.id, item.options);
    const env = [
      `WOC_INSTANCE_ID=${inst.id}`,
      `WOC_INSTANCE_NAME=${inst.name}`,
      `WOC_ADDON_ID=${item.id}`,
      `WOC_ADDON_OPTIONS=${optionsJson}`,
      `WOC_WECHAT_DATA=/config`,
      `WOC_OUTPUT_DIR=/out`,
      `WOC_PANEL_URL=http://woc-panel:${PANEL_PORT}`,
      `WOC_ADDON_TOKEN=${inst.addonToken || ''}`,
      `WOC_MCP_ADDR=0.0.0.0:${manifest.mcp?.port || 4545}`,
      `WOC_MCP_TOKEN=${inst.mcpToken || ''}`,
      `TZ=${TZ}`,
    ];

    const memBytes = parseMemoryBytes(manifest.resources?.memory);
    const specHash = createHash('sha256')
      .update(JSON.stringify({ image: manifest.image, binds, env, user: `${SAFE_UID}:${SAFE_GID}`, net: addonNet, memBytes }))
      .digest('hex')
      .slice(0, 16);

    const cname = addonContainerName(inst.id, item.id);
    const existing = docker.getContainer(cname);
    const info: any = await existing.inspect().catch(() => null);
    if (info) {
      const curHash = info.Config?.Labels?.['com.wechatoncloud.addon.spec-hash'];
      if (curHash === specHash) {
        if (!info.State?.Running) {
          await existing.start();
          appendInstanceLog(inst.id, `[addon] 插件「${manifest.name}」已启动`);
        }
        continue;
      }
      await stopAndRemoveContainer(existing);
    }

    const createOpts: Docker.ContainerCreateOptions = {
      name: cname,
      Image: manifest.image,
      User: `${SAFE_UID}:${SAFE_GID}`,
      Env: env,
      Labels: {
        'com.wechatoncloud.role': 'addon',
        'com.wechatoncloud.addon.instance': inst.id,
        'com.wechatoncloud.addon.id': item.id,
        'com.wechatoncloud.addon.spec-hash': specHash,
      },
      StopTimeout: 10,
      HostConfig: {
        Binds: binds,
        NetworkMode: addonNet,
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: memBytes,
        MemorySwap: memBytes,
        LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '2' } },
      },
    };

    const created = await docker.createContainer(createOpts);
    try {
      await created.start();
      appendInstanceLog(inst.id, `[addon] 插件「${manifest.name}」(${cname}) 已启动`);
      appendPanelLog('INFO', `实例「${inst.name}」(id=${inst.id}) 已启动插件「${manifest.name}」`);
    } catch (e) {
      await created.remove({ force: true }).catch(() => {});
      throw e;
    }
  }
}

export async function stopAddons(inst: Instance): Promise<void> {
  return withAddonLock(inst.id, async () => {
    const list = await docker
      .listContainers({
        all: true,
        filters: { label: [`com.wechatoncloud.addon.instance=${inst.id}`] },
      })
      .catch(() => []);
    for (const cInfo of list) {
      if (cInfo.State === 'running') {
        try {
          await docker.getContainer(cInfo.Id).stop({ t: 10 });
        } catch {
          /* ignore */
        }
      }
    }
  });
}

export async function removeAddons(inst: Instance, purgeVolume: boolean): Promise<void> {
  return withAddonLock(inst.id, async () => {
    const list = await docker
      .listContainers({
        all: true,
        filters: { label: [`com.wechatoncloud.addon.instance=${inst.id}`] },
      })
      .catch(() => []);
    for (const cInfo of list) {
      await stopAndRemoveContainer(docker.getContainer(cInfo.Id));
    }
    if (purgeVolume && !ADDON_OUTPUT_ROOT) {
      try {
        await docker.getVolume(addonOutputVolumeName(inst.id)).remove({ force: true });
      } catch {
        /* ignore */
      }
    }
  });
}

export async function reconcileAllAddons(instances: Instance[]): Promise<void> {
  for (const inst of instances) {
    if (!inst.addons?.length) continue;
    try {
      await ensureAddons(inst);
    } catch (e: any) {
      appendPanelLog('WARN', `[addon] 启动对齐实例「${inst.name}」(id=${inst.id}) 插件失败：${e?.message || e}`);
    }
  }
}

export async function getInstanceAddonStatuses(inst: Instance): Promise<AddonRuntimeStatus[]> {
  const enabled = (inst.addons || []).filter((a) => a && a.enabled !== false);
  if (enabled.length === 0) return [];
  const catalog = loadAddonCatalog();

  return Promise.all(
    enabled.map(async (item): Promise<AddonRuntimeStatus> => {
      const manifest = catalog.get(item.id);
      const cname = addonContainerName(inst.id, item.id);
      let runtime: RuntimeState = 'missing';
      try {
        const info: any = await docker.getContainer(cname).inspect();
        runtime = info?.State?.Running ? 'running' : 'stopped';
      } catch (e: any) {
        if (e?.statusCode !== 404) runtime = 'stopped';
      }

      const base: AddonRuntimeStatus = {
        id: item.id,
        name: manifest?.name || item.id,
        runtime,
        containerName: cname,
      };
      if (runtime !== 'running') return base;

      const port = manifest?.healthcheck?.port || 8080;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 800);
      try {
        const res = await fetch(`http://${cname}:${port}/status`, { signal: ctl.signal });
        if (res.ok) {
          const st: any = await res.json();
          return {
            ...base,
            state: typeof st?.state === 'string' ? st.state : undefined,
            lastRun: typeof st?.lastRun === 'string' ? st.lastRun : undefined,
            lastError: typeof st?.lastError === 'string' ? st.lastError : undefined,
            lastErrorDetail: typeof st?.lastErrorDetail === 'string' ? st.lastErrorDetail : undefined,
            lastSkipped: typeof st?.lastSkipped === 'string' ? st.lastSkipped : undefined,
            lastSkippedAt: typeof st?.lastSkippedAt === 'string' ? st.lastSkippedAt : undefined,
            updatedAt: typeof st?.updatedAt === 'string' ? st.updatedAt : undefined,
            accounts: Array.isArray(st?.accounts) ? st.accounts : undefined,
          };
        }
      } catch {
        /* sidecar 刚拉起或宿主机本地调试未处于 woc-addons 网络内：仅返回容器运行态 */
      } finally {
        clearTimeout(timer);
      }
      return base;
    }),
  );
}

// 常量时间校验 Bearer addonToken，并严格区分：
// - 缺/无效 token → 401
// - 有效 token 但属于别的实例 → 403（§17.2 #2）
// - 目标实例未启用声明该 panelAction 的插件 → 403
export function verifyAddonRequestToken(
  authHeader: string | undefined,
  targetInstId: string,
  requiredAction: PanelAction,
): { ok: true; instance: Instance } | { ok: false; statusCode: 401 | 403; error: string } {
  const m = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+(\S+)$/i) : null;
  const rawToken = m?.[1] || '';
  if (!rawToken) {
    return { ok: false, statusCode: 401, error: '缺少 Authorization Bearer token' };
  }
  const presented = Buffer.from(rawToken, 'utf8');
  let matchedInstance: Instance | null = null;

  for (const inst of listInstances()) {
    if (!inst.addonToken) continue;
    const expected = Buffer.from(inst.addonToken, 'utf8');
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
      matchedInstance = inst;
    }
  }

  if (!matchedInstance) {
    return { ok: false, statusCode: 401, error: '无效的 addon token' };
  }
  if (matchedInstance.id !== targetInstId) {
    return { ok: false, statusCode: 403, error: '该 token 无权访问目标实例' };
  }

  const catalog = loadAddonCatalog();
  const allowed = (matchedInstance.addons || []).some((a) => {
    if (!a || a.enabled === false) return false;
    const manifest = catalog.get(a.id);
    return !!manifest?.requires?.panelActions?.includes(requiredAction);
  });
  if (!allowed) {
    return { ok: false, statusCode: 403, error: `目标实例未启用声明了 ${requiredAction} 权限的插件` };
  }

  return { ok: true, instance: matchedInstance };
}

// 注册生命周期钩子，使 docker.ts 在启动/重启/停止/删除实例时自动同步 sidecar
registerAddonLifecycle({
  ensureAddons,
  stopAddons,
  removeAddons,
});
