import type { DatabaseSync } from 'node:sqlite';
import {
  AUTOMATION_APP_LIMITS,
  AUTOMATION_APP_SCHEMA_VERSION_V1,
  SCRIPT_STEP_KINDS,
  SECRET_SCAN_MAX_JSON_DEPTH,
  scanJsonForSecretLeaks,
  validateAutomationAppId,
  type AutomationAppDetail,
  type AutomationAppParam,
  type AutomationAppSummary,
  type AutomationScriptApp,
  type InstalledAutomationApp,
  type PublishAutomationAppRequest,
} from '@gpui-telegram/protocol';
import { parseBoundedQueryInt } from '../db/queries.js';
import { sha256Hex } from '../utils/crypto.js';
import {
  ApiError,
  authenticateToken,
  extractBearerToken,
  readJsonBody,
  readRawBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';

const VALID_STEP_KIND_SET = new Set<string>(SCRIPT_STEP_KINDS);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function slugifyAppSlug(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'automation-app'
  );
}

function optionalAuth(db: DatabaseSync, ctx: RequestContext) {
  const rawToken = extractBearerToken(ctx.req, ctx.query);
  return rawToken ? authenticateToken(db, rawToken) : null;
}

function requireValidAppId(raw: string): string {
  const check = validateAutomationAppId(raw);
  if (!check.valid) {
    throw new ApiError(400, 'invalid_app_id', check.error);
  }
  return check.normalized;
}

interface DuplicateKeyShadow {
  path: string;
  value: Record<string, unknown>;
}

function skipJsonWhitespace(input: string, pos: number): number {
  while (pos < input.length) {
    const c = input.charCodeAt(pos);
    if (c === 32 || c === 9 || c === 10 || c === 13) pos++;
    else break;
  }
  return pos;
}

function readJsonStringToken(input: string, start: number): { value: string; nextPos: number } {
  let i = start + 1;
  while (i < input.length) {
    const c = input.charCodeAt(i);
    if (c === 92) {
      i += 2;
      continue;
    }
    if (c === 34) {
      return {
        value: JSON.parse(input.slice(start, i + 1)) as string,
        nextPos: i + 1,
      };
    }
    i++;
  }
  throw new ApiError(400, 'invalid_json', 'Unterminated JSON string');
}

function extractDuplicateKeyShadows(
  input: string,
  rootContext: string,
  maxDepth: number = SECRET_SCAN_MAX_JSON_DEPTH,
): { shadows: DuplicateKeyShadow[]; depthExceeded: boolean } {
  const shadows: DuplicateKeyShadow[] = [];
  let pos = skipJsonWhitespace(input, 0);
  if (pos >= input.length || input.charCodeAt(pos) !== 123) {
    return { shadows, depthExceeded: false };
  }

  type ObjFrame = {
    kind: 'obj';
    path: string;
    state: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'commaOrEnd';
    map: Record<string, unknown>;
    dupEntries: Array<[string, unknown]>;
    pendingKey: string | null;
    sawIsSecretTrue: boolean;
  };
  type ArrFrame = {
    kind: 'arr';
    path: string;
    state: 'valueOrEnd' | 'value' | 'commaOrEnd';
    items: unknown[];
  };

  const rootMap = Object.create(null) as Record<string, unknown>;
  const stack: Array<ObjFrame | ArrFrame> = [
    {
      kind: 'obj',
      path: rootContext,
      state: 'keyOrEnd',
      map: rootMap,
      dupEntries: [],
      pendingKey: null,
      sawIsSecretTrue: false,
    },
  ];
  pos++;

  const attachValue = (top: ObjFrame | ArrFrame, val: unknown): void => {
    if (top.kind === 'arr') {
      top.items.push(val);
      top.state = 'commaOrEnd';
    } else {
      const key = top.pendingKey!;
      top.pendingKey = null;
      if (key === 'is_secret' && val === true) {
        top.sawIsSecretTrue = true;
      }
      if (key in top.map) {
        top.dupEntries.push([key, top.map[key]]);
      }
      top.map[key] = val;
      top.state = 'commaOrEnd';
    }
  };

  const flushObjectFrame = (frame: ObjFrame): void => {
    if (frame.dupEntries.length === 0) return;
    const isParamObj = /^(?:request\.manifest|app)\.parameters\[\d+\]$/.test(frame.path);
    for (const [dupKey, dupVal] of frame.dupEntries) {
      const shadowObj = Object.create(null) as Record<string, unknown>;
      if (isParamObj) {
        if ('name' in frame.map) shadowObj.name = frame.map.name;
        if ('is_secret' in frame.map) {
          shadowObj.is_secret = frame.sawIsSecretTrue ? true : frame.map.is_secret;
        } else if (frame.sawIsSecretTrue) {
          shadowObj.is_secret = true;
        }
        if ('default_value' in frame.map) shadowObj.default_value = frame.map.default_value;
      }
      shadowObj[dupKey] = dupVal;
      shadows.push({ path: frame.path, value: shadowObj });
    }
  };

  while (stack.length > 0) {
    pos = skipJsonWhitespace(input, pos);
    if (pos >= input.length) break;
    const top = stack[stack.length - 1]!;
    const ch = input.charCodeAt(pos);

    if (top.kind === 'obj') {
      if (top.state === 'keyOrEnd' || top.state === 'key') {
        if (top.state === 'keyOrEnd' && ch === 125) {
          pos++;
          stack.pop();
          flushObjectFrame(top);
          continue;
        }
        const parsedKey = readJsonStringToken(input, pos);
        top.pendingKey = parsedKey.value;
        pos = parsedKey.nextPos;
        top.state = 'colon';
        continue;
      }
      if (top.state === 'colon') {
        pos++; // ':'
        top.state = 'value';
        continue;
      }
      if (top.state === 'commaOrEnd') {
        if (ch === 125) {
          pos++;
          stack.pop();
          flushObjectFrame(top);
          continue;
        }
        pos++; // ','
        top.state = 'key';
        continue;
      }
    } else {
      if (top.state === 'valueOrEnd' && ch === 93) {
        pos++;
        stack.pop();
        continue;
      }
      if (top.state === 'commaOrEnd') {
        if (ch === 93) {
          pos++;
          stack.pop();
          continue;
        }
        pos++; // ','
        top.state = 'value';
        continue;
      }
    }

    // Parsing a value inside `top` (depth = stack.length)
    if (stack.length > maxDepth) {
      return { shadows, depthExceeded: true };
    }

    const childPath =
      top.kind === 'obj' ? `${top.path}.${top.pendingKey!}` : `${top.path}[${top.items.length}]`;

    if (ch === 123) {
      const childMap = Object.create(null) as Record<string, unknown>;
      attachValue(top, childMap);
      pos++;
      stack.push({
        kind: 'obj',
        path: childPath,
        state: 'keyOrEnd',
        map: childMap,
        dupEntries: [],
        pendingKey: null,
        sawIsSecretTrue: false,
      });
    } else if (ch === 91) {
      const childArr: unknown[] = [];
      attachValue(top, childArr);
      pos++;
      stack.push({
        kind: 'arr',
        path: childPath,
        state: 'valueOrEnd',
        items: childArr,
      });
    } else if (ch === 34) {
      const parsedStr = readJsonStringToken(input, pos);
      attachValue(top, parsedStr.value);
      pos = parsedStr.nextPos;
    } else if (ch === 116) {
      attachValue(top, true);
      pos += 4;
    } else if (ch === 102) {
      attachValue(top, false);
      pos += 5;
    } else if (ch === 110) {
      attachValue(top, null);
      pos += 4;
    } else {
      let end = pos;
      while (end < input.length) {
        const nc = input.charCodeAt(end);
        if (
          (nc >= 48 && nc <= 57) ||
          nc === 45 ||
          nc === 43 ||
          nc === 46 ||
          nc === 101 ||
          nc === 69
        ) {
          end++;
        } else {
          break;
        }
      }
      attachValue(top, Number(input.slice(pos, end)));
      pos = end;
    }
  }

  return { shadows, depthExceeded: false };
}

function validateAndNormalizeManifest(rawManifest: unknown): AutomationScriptApp {
  if (!isPlainObject(rawManifest)) {
    throw new ApiError(400, 'invalid_manifest', 'manifest must be a JSON object');
  }

  const schemaVersion = Number(rawManifest.schema_version);
  if (schemaVersion !== AUTOMATION_APP_SCHEMA_VERSION_V1) {
    throw new ApiError(
      400,
      'invalid_schema_version',
      `manifest.schema_version must be ${AUTOMATION_APP_SCHEMA_VERSION_V1}`,
    );
  }

  const appId = typeof rawManifest.app_id === 'string' ? rawManifest.app_id.trim() : '';
  const appIdCheck = validateAutomationAppId(appId);
  if (!appIdCheck.valid) {
    throw new ApiError(400, 'invalid_app_id', appIdCheck.error);
  }

  const name = typeof rawManifest.name === 'string' ? rawManifest.name.trim() : '';
  if (!name || name.length > AUTOMATION_APP_LIMITS.maxNameLen) {
    throw new ApiError(
      400,
      'invalid_name',
      `manifest.name must be 1..${AUTOMATION_APP_LIMITS.maxNameLen} characters`,
    );
  }

  const version = typeof rawManifest.version === 'string' ? rawManifest.version.trim() : '';
  if (!version || version.length > AUTOMATION_APP_LIMITS.maxVersionLen) {
    throw new ApiError(
      400,
      'invalid_version',
      `manifest.version must be 1..${AUTOMATION_APP_LIMITS.maxVersionLen} characters`,
    );
  }

  const category =
    typeof rawManifest.category === 'string' && rawManifest.category.trim()
      ? rawManifest.category.trim()
      : 'general';
  if (category.length > AUTOMATION_APP_LIMITS.maxCategoryLen) {
    throw new ApiError(
      400,
      'invalid_category',
      `manifest.category must be <= ${AUTOMATION_APP_LIMITS.maxCategoryLen} characters`,
    );
  }

  const steps = rawManifest.steps;
  if (
    !Array.isArray(steps) ||
    steps.length === 0 ||
    steps.length > AUTOMATION_APP_LIMITS.maxStepsCount
  ) {
    throw new ApiError(
      400,
      'invalid_steps',
      `manifest.steps must contain 1..${AUTOMATION_APP_LIMITS.maxStepsCount} steps`,
    );
  }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!isPlainObject(step) || typeof step.kind !== 'string' || !VALID_STEP_KIND_SET.has(step.kind)) {
      throw new ApiError(400, 'invalid_step', `Step #${i} has an unsupported or missing kind`);
    }
  }

  const rawParams = rawManifest.parameters ?? [];
  if (!Array.isArray(rawParams) || rawParams.length > AUTOMATION_APP_LIMITS.maxParametersCount) {
    throw new ApiError(
      400,
      'invalid_parameters',
      `manifest.parameters must be an array of <= ${AUTOMATION_APP_LIMITS.maxParametersCount} entries`,
    );
  }
  const parameters: AutomationAppParam[] = [];
  for (const p of rawParams) {
    if (!isPlainObject(p) || typeof p.name !== 'string' || !p.name.trim()) {
      throw new ApiError(400, 'invalid_parameters', 'Every parameter must have a non-empty string name');
    }
    parameters.push({
      name: p.name.trim(),
      description: typeof p.description === 'string' ? p.description : '',
      required: p.required !== undefined ? Boolean(p.required) : true,
      default_value: typeof p.default_value === 'string' ? p.default_value : null,
      is_secret: Boolean(p.is_secret),
    });
  }

  const rawDomains = rawManifest.target_domains ?? [];
  if (!Array.isArray(rawDomains) || rawDomains.length > AUTOMATION_APP_LIMITS.maxDomainsCount) {
    throw new ApiError(
      400,
      'invalid_domains',
      `manifest.target_domains must be an array of <= ${AUTOMATION_APP_LIMITS.maxDomainsCount} entries`,
    );
  }
  const targetDomains = Array.from(
    new Set(
      rawDomains
        .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
        .map((d) => d.trim().toLowerCase()),
    ),
  );

  const rawCaps = rawManifest.required_capabilities ?? [];
  const requiredCapabilities = Array.isArray(rawCaps)
    ? Array.from(
        new Set(rawCaps.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)),
      )
    : [];

  const slug =
    typeof rawManifest.slug === 'string' && rawManifest.slug.trim()
      ? slugifyAppSlug(rawManifest.slug)
      : slugifyAppSlug(name);

  if (
    rawManifest.author_id !== undefined &&
    rawManifest.author_id !== null &&
    typeof rawManifest.author_id !== 'string'
  ) {
    throw new ApiError(400, 'invalid_manifest', 'manifest.author_id must be a string when provided');
  }
  const declaredAuthorId =
    typeof rawManifest.author_id === 'string' && rawManifest.author_id.trim().length > 0
      ? rawManifest.author_id.trim()
      : null;

  return {
    schema_version: AUTOMATION_APP_SCHEMA_VERSION_V1,
    app_id: appIdCheck.normalized,
    slug,
    name,
    version,
    description: typeof rawManifest.description === 'string' ? rawManifest.description.trim() : '',
    category,
    target_domains: targetDomains,
    parameters,
    steps: steps as AutomationScriptApp['steps'],
    required_capabilities: requiredCapabilities,
    author_id: declaredAuthorId,
    source_trace_summary:
      typeof rawManifest.source_trace_summary === 'string'
        ? rawManifest.source_trace_summary
        : null,
  };
}

function rowToSummary(
  row: Record<string, unknown>,
  isInstalled: boolean,
): AutomationAppSummary {
  const manifest = JSON.parse(String(row.manifest_json)) as AutomationScriptApp;
  const targetDomains = JSON.parse(String(row.target_domains_json || '[]')) as string[];
  return {
    app_id: String(row.app_id),
    slug: String(row.slug),
    author_user_id: Number(row.author_user_id),
    author_username: (row.author_username as string | null) ?? null,
    name: String(row.name),
    description: String(row.description ?? ''),
    category: String(row.category ?? 'general'),
    target_domains: targetDomains,
    latest_version: String(row.latest_version),
    required_capabilities: Array.isArray(manifest.required_capabilities)
      ? manifest.required_capabilities
      : [],
    step_count: Array.isArray(manifest.steps) ? manifest.steps.length : 0,
    parameters: Array.isArray(manifest.parameters) ? manifest.parameters : [],
    install_count: Number(row.install_count ?? 0),
    run_count: Number(row.run_count ?? 0),
    is_published: Boolean(Number(row.is_published)),
    is_installed: isInstalled,
    created_at_ms: Number(row.created_at_ms),
    updated_at_ms: Number(row.updated_at_ms),
  };
}

function loadAppDetail(
  db: DatabaseSync,
  appId: string,
  viewerUserId: number | null,
  requestedVersion?: string | null,
): AutomationAppDetail | null {
  const row = db
    .prepare(
      `SELECT a.*, u.username AS author_username
       FROM automation_apps a
       LEFT JOIN users u ON u.user_id = a.author_user_id
       WHERE a.app_id = ?`,
    )
    .get(appId) as Record<string, unknown> | undefined;

  if (!row) return null;
  const isPublished = Boolean(Number(row.is_published));
  if (!isPublished && (viewerUserId === null || Number(row.author_user_id) !== viewerUserId)) {
    return null;
  }

  const versionRows = db
    .prepare(
      `SELECT version, manifest_json, content_sha256
       FROM automation_app_versions
       WHERE app_id = ?
       ORDER BY created_at_ms DESC, rowid DESC`,
    )
    .all(appId) as Array<{ version: string; manifest_json: string; content_sha256: string }>;

  const versions = versionRows.map((v) => v.version);
  let selectedManifestJson = String(row.manifest_json);
  let selectedSha256 = sha256Hex(selectedManifestJson);

  if (requestedVersion && requestedVersion.trim()) {
    const verMatch = versionRows.find((v) => v.version === requestedVersion.trim());
    if (!verMatch) {
      throw new ApiError(404, 'version_not_found', `Version '${requestedVersion}' not found for app '${appId}'`);
    }
    selectedManifestJson = verMatch.manifest_json;
    selectedSha256 = verMatch.content_sha256;
  } else if (versionRows.length > 0) {
    selectedManifestJson = versionRows[0]!.manifest_json;
    selectedSha256 = versionRows[0]!.content_sha256;
  }

  const installedRow =
    viewerUserId !== null
      ? (db
          .prepare(`SELECT installed_version FROM user_automation_apps WHERE user_id = ? AND app_id = ?`)
          .get(viewerUserId, appId) as { installed_version: string } | undefined)
      : undefined;

  const manifest = JSON.parse(selectedManifestJson) as AutomationScriptApp;
  const targetDomains = JSON.parse(String(row.target_domains_json || '[]')) as string[];

  return {
    app_id: String(row.app_id),
    slug: String(row.slug),
    author_user_id: Number(row.author_user_id),
    author_username: (row.author_username as string | null) ?? null,
    name: String(row.name),
    description: String(row.description ?? ''),
    category: String(row.category ?? 'general'),
    target_domains: targetDomains,
    latest_version: String(row.latest_version),
    versions,
    manifest,
    content_sha256: selectedSha256,
    install_count: Number(row.install_count ?? 0),
    run_count: Number(row.run_count ?? 0),
    is_published: isPublished,
    is_installed: Boolean(installedRow),
    installed_version: installedRow?.installed_version ?? null,
    created_at_ms: Number(row.created_at_ms),
    updated_at_ms: Number(row.updated_at_ms),
  };
}

function rowToInstalledApp(row: Record<string, unknown>): InstalledAutomationApp {
  const manifestJson = String(row.installed_manifest_json || row.manifest_json);
  const manifest = JSON.parse(manifestJson) as AutomationScriptApp;
  const targetDomains = Array.isArray(manifest.target_domains)
    ? manifest.target_domains
    : (JSON.parse(String(row.target_domains_json || '[]')) as string[]);
  const contentSha256 =
    typeof row.installed_sha256 === 'string' && row.installed_sha256
      ? row.installed_sha256
      : sha256Hex(manifestJson);
  return {
    app_id: String(row.app_id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description ?? ''),
    category: String(row.category ?? 'general'),
    target_domains: targetDomains,
    installed_version: String(row.installed_version),
    latest_version: String(row.latest_version),
    manifest,
    content_sha256: contentSha256,
    installed_at_ms: Number(row.installed_at_ms),
    last_run_at_ms:
      row.last_run_at_ms !== null && row.last_run_at_ms !== undefined
        ? Number(row.last_run_at_ms)
        : null,
    local_run_count: Number(row.local_run_count ?? 0),
  };
}

const INSTALLED_APPS_SELECT = `
  SELECT
    a.app_id, a.slug, a.name, a.description, a.category, a.target_domains_json,
    a.latest_version, a.manifest_json,
    ua.installed_version, ua.installed_at_ms, ua.last_run_at_ms,
    v.manifest_json AS installed_manifest_json,
    v.content_sha256 AS installed_sha256,
    (SELECT COUNT(*) FROM automation_app_runs r WHERE r.app_id = ua.app_id AND r.user_id = ua.user_id) AS local_run_count
  FROM user_automation_apps ua
  INNER JOIN automation_apps a ON a.app_id = ua.app_id
  LEFT JOIN automation_app_versions v
    ON v.app_id = ua.app_id AND v.version = ua.installed_version
`;

function listInstalledApps(db: DatabaseSync, userId: number): InstalledAutomationApp[] {
  const rows = db
    .prepare(
      `${INSTALLED_APPS_SELECT}
       WHERE ua.user_id = ? AND (a.is_published = 1 OR a.author_user_id = ?)
       ORDER BY ua.installed_at_ms DESC`,
    )
    .all(userId, userId) as Array<Record<string, unknown>>;
  return rows.map(rowToInstalledApp);
}

function loadInstalledApp(
  db: DatabaseSync,
  userId: number,
  appId: string,
): InstalledAutomationApp | null {
  const row = db
    .prepare(`${INSTALLED_APPS_SELECT} WHERE ua.user_id = ? AND ua.app_id = ?`)
    .get(userId, appId) as Record<string, unknown> | undefined;
  return row ? rowToInstalledApp(row) : null;
}

export function registerAutomationAppRoutes(router: HttpRouter, db: DatabaseSync): void {
  // 1. Catalog Search (`GET /api/v1/automation-apps`)
  router.get('/api/v1/automation-apps', (ctx) => {
    const auth = optionalAuth(db, ctx);
    const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
    const category = (ctx.query.get('category') ?? '').trim().toLowerCase();
    const domain = (ctx.query.get('domain') ?? '').trim().toLowerCase();
    const sort = (ctx.query.get('sort') ?? 'popular').trim().toLowerCase();
    const limit = parseBoundedQueryInt(ctx.query.get('limit'), 50, 1, 100);
    const offset = parseBoundedQueryInt(ctx.query.get('offset'), 0, 0, 10_000);

    const orderClause =
      sort === 'recent'
        ? 'a.updated_at_ms DESC, a.install_count DESC'
        : 'a.install_count DESC, a.run_count DESC, a.updated_at_ms DESC';

    const rows = db
      .prepare(
        `SELECT a.*, u.username AS author_username
         FROM automation_apps a
         LEFT JOIN users u ON u.user_id = a.author_user_id
         WHERE a.is_published = 1
         ORDER BY ${orderClause}`,
      )
      .all() as Array<Record<string, unknown>>;

    const installedSet = new Set(
      auth !== null
        ? (
            db
              .prepare(`SELECT app_id FROM user_automation_apps WHERE user_id = ?`)
              .all(auth.userId) as Array<{ app_id: string }>
          ).map((r) => r.app_id)
        : [],
    );

    let filtered = rows.map((r) => rowToSummary(r, installedSet.has(String(r.app_id))));

    if (q) {
      filtered = filtered.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.slug.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.target_domains.some((d) => d.toLowerCase().includes(q)),
      );
    }
    if (category && category !== 'all') {
      filtered = filtered.filter((a) => a.category.toLowerCase() === category);
    }
    if (domain) {
      filtered = filtered.filter((a) =>
        a.target_domains.some((d) => d.toLowerCase() === domain || d.toLowerCase().endsWith(`.${domain}`)),
      );
    }

    const total = filtered.length;
    const apps = filtered.slice(offset, offset + limit);
    sendJson(ctx.res, 200, { apps, total, limit, offset });
  });

  // 2a. Canonical Installed Apps (`GET /api/v1/automation-apps/installed` — MUST be BEFORE `:appId`!)
  router.get('/api/v1/automation-apps/installed', (ctx) => {
    const auth = requireAuth(db, ctx);
    const apps = listInstalledApps(db, auth.userId);
    sendJson(ctx.res, 200, { apps, installed: apps, total: apps.length });
  });

  // 2b. Installed & Authored Apps alias (`GET /api/v1/automation-apps/mine` — MUST be BEFORE `:appId`!)
  router.get('/api/v1/automation-apps/mine', (ctx) => {
    const auth = requireAuth(db, ctx);
    const installed = listInstalledApps(db, auth.userId);
    const authoredRows = db
      .prepare(
        `SELECT a.*, u.username AS author_username
         FROM automation_apps a
         LEFT JOIN users u ON u.user_id = a.author_user_id
         WHERE a.author_user_id = ?
         ORDER BY a.updated_at_ms DESC`,
      )
      .all(auth.userId) as Array<Record<string, unknown>>;
    const installedIds = new Set(installed.map((a) => a.app_id));
    const authored = authoredRows.map((r) => rowToSummary(r, installedIds.has(String(r.app_id))));
    sendJson(ctx.res, 200, { apps: installed, installed, authored, total: installed.length });
  });

  // 3. Publish / Update Version (`POST /api/v1/automation-apps` — 512 KiB cap + Two-Pass Secret Scanner!)
  router.post('/api/v1/automation-apps', async (ctx) => {
    const auth = requireAuth(db, ctx);

    let rawBuf: Buffer;
    try {
      rawBuf = await readRawBody(ctx.req, AUTOMATION_APP_LIMITS.maxPublishPayloadBytes);
    } catch (err) {
      if (err instanceof ApiError && err.status === 413) {
        throw new ApiError(
          400,
          'payload_too_large',
          'Publish payload exceeds maximum size of 512 KiB',
        );
      }
      throw err;
    }
    if (rawBuf.length === 0) {
      throw new ApiError(400, 'invalid_json', 'Request body is required');
    }

    const rawJsonText = rawBuf.toString('utf8');
    let body: PublishAutomationAppRequest & Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawJsonText);
      if (!isPlainObject(parsed)) {
        throw new ApiError(400, 'invalid_json', 'Request body must be a JSON object');
      }
      body = parsed as unknown as PublishAutomationAppRequest & Record<string, unknown>;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(400, 'invalid_json', 'Malformed JSON body');
    }

    const hasWrappedManifest = body.manifest !== undefined && body.manifest !== null;
    const rawManifest = hasWrappedManifest ? body.manifest : body;
    const rootContext = hasWrappedManifest ? 'request' : 'app';
    const manifest = validateAndNormalizeManifest(rawManifest);

    // Defense-in-depth two-pass server-side secret leak scan:
    // Pass A: Full parsed request payload (`manifest`, `changelog`, and all top-level/unknown fields)
    const leakScan = scanJsonForSecretLeaks(body, {
      context: rootContext,
      parameters: manifest.parameters,
    });
    if (!leakScan.safe) {
      const first = leakScan.findings[0];
      throw new ApiError(
        422,
        'secret_leak_detected',
        `Publication rejected: potential secret detected (${first?.reason ?? 'secret_pattern'} at ${first?.path ?? '$'})`,
        { findings: leakScan.findings },
      );
    }

    // Pass B: Iterative O(N) RFC 8259 duplicate-key shadow extractor over raw JSON text
    const shadowScan = extractDuplicateKeyShadows(
      rawJsonText,
      rootContext,
      SECRET_SCAN_MAX_JSON_DEPTH,
    );
    if (shadowScan.depthExceeded) {
      throw new ApiError(
        422,
        'secret_leak_detected',
        'Publication rejected: JSON nesting depth exceeds maximum allowed for secret scanning',
        {
          findings: [
            {
              rule: 'max_depth_exceeded',
              path: rootContext,
              reason: `JSON nesting depth exceeds ${SECRET_SCAN_MAX_JSON_DEPTH}`,
            },
          ],
        },
      );
    }
    for (const shadow of shadowScan.shadows) {
      const sRes = scanJsonForSecretLeaks(shadow.value, {
        context: shadow.path,
        parameters: manifest.parameters,
      });
      if (!sRes.safe) {
        const first = sRes.findings[0];
        throw new ApiError(
          422,
          'secret_leak_detected',
          `Publication rejected: potential secret detected in shadowed duplicate key (${first?.reason ?? 'secret_pattern'} at ${first?.path ?? shadow.path})`,
          { findings: sRes.findings },
        );
      }
    }

    // Author anti-spoofing guard (before hashing & persisting)
    const callerAuthorId = String(auth.userId);
    if (manifest.author_id !== null && manifest.author_id !== callerAuthorId) {
      throw new ApiError(
        403,
        'forbidden',
        'manifest author_id does not match authenticated user',
      );
    }
    manifest.author_id = callerAuthorId;

    const isPublished = body.is_published !== false ? 1 : 0;
    const manifestJson = JSON.stringify(manifest);
    const contentSha256 = sha256Hex(manifestJson);
    const now = Date.now();
    let createdNewApp = false;

    db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = db
        .prepare(`SELECT author_user_id, created_at_ms FROM automation_apps WHERE app_id = ?`)
        .get(manifest.app_id) as { author_user_id: number; created_at_ms: number } | undefined;

      if (existing && Number(existing.author_user_id) !== auth.userId) {
        db.exec('ROLLBACK;');
        throw new ApiError(
          403,
          'forbidden',
          `Automation app '${manifest.app_id}' is owned by another author`,
        );
      }

      const existingVersion = db
        .prepare(`SELECT 1 FROM automation_app_versions WHERE app_id = ? AND version = ?`)
        .get(manifest.app_id, manifest.version);
      if (existingVersion) {
        db.exec('ROLLBACK;');
        throw new ApiError(
          409,
          'version_conflict',
          `Version '${manifest.version}' is already published for app '${manifest.app_id}'`,
        );
      }

      createdNewApp = !existing;

      if (existing) {
        db.prepare(`
          UPDATE automation_apps
          SET slug = ?, name = ?, description = ?, category = ?, target_domains_json = ?,
              latest_version = ?, manifest_json = ?, is_published = ?, updated_at_ms = ?
          WHERE app_id = ?
        `).run(
          manifest.slug,
          manifest.name,
          manifest.description,
          manifest.category,
          JSON.stringify(manifest.target_domains),
          manifest.version,
          manifestJson,
          isPublished,
          now,
          manifest.app_id,
        );
      } else {
        db.prepare(`
          INSERT INTO automation_apps (
            app_id, slug, author_user_id, name, description, category, target_domains_json,
            latest_version, manifest_json, install_count, run_count, is_published, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
        `).run(
          manifest.app_id,
          manifest.slug,
          auth.userId,
          manifest.name,
          manifest.description,
          manifest.category,
          JSON.stringify(manifest.target_domains),
          manifest.version,
          manifestJson,
          isPublished,
          now,
          now,
        );
      }

      db.prepare(`
        INSERT INTO automation_app_versions (
          app_id, version, manifest_json, content_sha256, created_at_ms
        ) VALUES (?, ?, ?, ?, ?)
      `).run(manifest.app_id, manifest.version, manifestJson, contentSha256, now);

      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Already rolled back
      }
      throw err;
    }

    const detail = loadAppDetail(db, manifest.app_id, auth.userId);
    sendJson(ctx.res, createdNewApp ? 201 : 200, detail);
  });

  // 4. App Detail (`GET /api/v1/automation-apps/:appId?version=...`)
  router.get('/api/v1/automation-apps/:appId', (ctx) => {
    const auth = optionalAuth(db, ctx);
    const appId = requireValidAppId(ctx.params.appId!);
    const version = ctx.query.get('version');
    const detail = loadAppDetail(db, appId, auth?.userId ?? null, version);
    if (!detail) {
      throw new ApiError(404, 'not_found', `Automation app '${appId}' not found`);
    }
    sendJson(ctx.res, 200, detail);
  });

  // 5. Idempotent Install / Upgrade (`POST /api/v1/automation-apps/:appId/install`)
  router.post('/api/v1/automation-apps/:appId/install', (ctx) => {
    const auth = requireAuth(db, ctx);
    const appId = requireValidAppId(ctx.params.appId!);
    const now = Date.now();
    let installedVersion = '';
    let installCount = 0;
    let newlyInstalled = false;

    db.exec('BEGIN IMMEDIATE;');
    try {
      const appRow = db
        .prepare(`SELECT author_user_id, latest_version, is_published FROM automation_apps WHERE app_id = ?`)
        .get(appId) as
        | { author_user_id: number; latest_version: string; is_published: number }
        | undefined;
      if (!appRow || (!Number(appRow.is_published) && Number(appRow.author_user_id) !== auth.userId)) {
        db.exec('ROLLBACK;');
        throw new ApiError(404, 'not_found', `Automation app '${appId}' not found`);
      }

      installedVersion = appRow.latest_version;
      const existingInstall = db
        .prepare(`SELECT 1 FROM user_automation_apps WHERE user_id = ? AND app_id = ?`)
        .get(auth.userId, appId);
      newlyInstalled = !existingInstall;

      if (newlyInstalled) {
        db.prepare(`
          INSERT INTO user_automation_apps (
            user_id, app_id, installed_version, installed_at_ms, last_run_at_ms
          ) VALUES (?, ?, ?, ?, NULL)
        `).run(auth.userId, appId, installedVersion, now);
      } else {
        db.prepare(`
          UPDATE user_automation_apps
          SET installed_version = ?
          WHERE user_id = ? AND app_id = ?
        `).run(installedVersion, auth.userId, appId);
      }

      const cntRow = db
        .prepare(`SELECT COUNT(*) AS cnt FROM user_automation_apps WHERE app_id = ?`)
        .get(appId) as { cnt: number };
      installCount = Number(cntRow.cnt ?? 0);

      db.prepare(`UPDATE automation_apps SET install_count = ? WHERE app_id = ?`).run(
        installCount,
        appId,
      );
      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Already rolled back
      }
      throw err;
    }

    const installedApp = loadInstalledApp(db, auth.userId, appId)!;
    sendJson(ctx.res, 200, {
      ok: true,
      app: installedApp,
      app_id: appId,
      installed_version: installedVersion,
      install_count: installCount,
      newly_installed: newlyInstalled,
      is_installed: true,
    });
  });

  // 6. Uninstall (`DELETE /api/v1/automation-apps/:appId/install`)
  router.delete('/api/v1/automation-apps/:appId/install', (ctx) => {
    const auth = requireAuth(db, ctx);
    const appId = requireValidAppId(ctx.params.appId!);
    let installCount = 0;
    let removed = false;

    db.exec('BEGIN IMMEDIATE;');
    try {
      const appRow = db
        .prepare(`SELECT author_user_id, is_published FROM automation_apps WHERE app_id = ?`)
        .get(appId) as { author_user_id: number; is_published: number } | undefined;
      if (!appRow || (!Number(appRow.is_published) && Number(appRow.author_user_id) !== auth.userId)) {
        db.exec('ROLLBACK;');
        throw new ApiError(404, 'not_found', `Automation app '${appId}' not found`);
      }

      const delRes = db
        .prepare(`DELETE FROM user_automation_apps WHERE user_id = ? AND app_id = ?`)
        .run(auth.userId, appId);
      removed = Number(delRes.changes ?? 0) > 0;

      const cntRow = db
        .prepare(`SELECT COUNT(*) AS cnt FROM user_automation_apps WHERE app_id = ?`)
        .get(appId) as { cnt: number };
      installCount = Number(cntRow.cnt ?? 0);

      db.prepare(`UPDATE automation_apps SET install_count = ? WHERE app_id = ?`).run(
        installCount,
        appId,
      );
      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Already rolled back
      }
      throw err;
    }

    sendJson(ctx.res, 200, {
      ok: true,
      app_id: appId,
      removed,
      installed: false,
      is_installed: false,
      install_count: installCount,
    });
  });

  // 7. Run Telemetry (`POST /api/v1/automation-apps/:appId/runs`)
  router.post('/api/v1/automation-apps/:appId/runs', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const appId = requireValidAppId(ctx.params.appId!);
    const body = await readJsonBody<{
      version?: unknown;
      success?: unknown;
      steps_executed?: unknown;
      total_duration_ms?: unknown;
      used_llm?: unknown;
      error?: unknown;
    }>(ctx.req);

    let requestedVersion: string | null = null;
    if (body.version !== undefined && body.version !== null) {
      if (typeof body.version !== 'string') {
        throw new ApiError(400, 'validation_error', 'version must be a string when provided');
      }
      const trimmed = body.version.trim();
      if (!trimmed || trimmed.length > AUTOMATION_APP_LIMITS.maxVersionLen) {
        throw new ApiError(
          400,
          'validation_error',
          `version must be 1..=${AUTOMATION_APP_LIMITS.maxVersionLen} characters when provided`,
        );
      }
      requestedVersion = trimmed;
    }

    const now = Date.now();
    let runId = 0;
    let runCount = 0;
    const successBool = body.success !== false;
    const usedLlmBool = body.used_llm === true;

    db.exec('BEGIN IMMEDIATE;');
    try {
      const appRow = db
        .prepare(`SELECT author_user_id, latest_version, run_count, is_published FROM automation_apps WHERE app_id = ?`)
        .get(appId) as
        | { author_user_id: number; latest_version: string; run_count: number; is_published: number }
        | undefined;
      if (!appRow || (!Number(appRow.is_published) && Number(appRow.author_user_id) !== auth.userId)) {
        db.exec('ROLLBACK;');
        throw new ApiError(404, 'not_found', `Automation app '${appId}' not found`);
      }

      const version = requestedVersion ?? appRow.latest_version;
      const verExists = db
        .prepare(`SELECT 1 FROM automation_app_versions WHERE app_id = ? AND version = ?`)
        .get(appId, version);
      if (!verExists) {
        db.exec('ROLLBACK;');
        throw new ApiError(
          400,
          'validation_error',
          `Unknown version '${version}' for automation app '${appId}'`,
        );
      }

      const success = successBool ? 1 : 0;
      const stepsExecuted = Math.max(0, Math.floor(Number(body.steps_executed ?? 0) || 0));
      const totalDurationMs = Math.max(0, Math.floor(Number(body.total_duration_ms ?? 0) || 0));
      const usedLlm = usedLlmBool ? 1 : 0;
      const errorText = typeof body.error === 'string' && body.error.trim() ? body.error.trim().slice(0, 500) : null;

      const ins = db
        .prepare(`
          INSERT INTO automation_app_runs (
            app_id, user_id, version, success, steps_executed,
            total_duration_ms, used_llm, error, recorded_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(appId, auth.userId, version, success, stepsExecuted, totalDurationMs, usedLlm, errorText, now);
      runId = Number(ins.lastInsertRowid);

      runCount = Number(appRow.run_count ?? 0) + 1;
      db.prepare(`UPDATE automation_apps SET run_count = ?, updated_at_ms = ? WHERE app_id = ?`).run(
        runCount,
        now,
        appId,
      );
      db.prepare(
        `UPDATE user_automation_apps SET last_run_at_ms = ? WHERE user_id = ? AND app_id = ?`,
      ).run(now, auth.userId, appId);

      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Already rolled back
      }
      throw err;
    }

    sendJson(ctx.res, 200, {
      ok: true,
      app_id: appId,
      run_id: runId,
      run_count: runCount,
      last_run_at_ms: now,
      recorded_at_ms: now,
      used_llm: usedLlmBool,
      status: successBool ? 'succeeded' : 'failed',
    });
  });
}
