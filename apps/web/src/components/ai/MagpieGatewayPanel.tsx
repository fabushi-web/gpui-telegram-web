import React, { useEffect, useMemo, useState } from 'react';
import {
  DOM_IDS,
  type MagpieApiMode,
  type MagpieProviderView,
  type MagpieRoutingStrategy,
} from '@gpui-telegram/protocol';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useUiStore } from '../../store/useUiStore';

export interface MagpieGatewayPanelProps {
  embedded?: boolean;
  asModal?: boolean;
  onClose?: () => void;
}

type RealMagpieApiMode =
  | 'chat_completions'
  | 'codex_responses'
  | 'anthropic_messages'
  | 'gemini_generate_content';

const ALLOWED_API_MODES = new Set<string>([
  'chat_completions',
  'codex_responses',
  'anthropic_messages',
  'gemini_generate_content',
]);

function toRealApiMode(raw: MagpieApiMode | string | undefined): RealMagpieApiMode {
  return raw && ALLOWED_API_MODES.has(raw) ? (raw as RealMagpieApiMode) : 'chat_completions';
}

const ROUTING_STRATEGY_OPTIONS: Array<{
  value: MagpieRoutingStrategy;
  label: string;
}> = [
  { value: 'smart', label: 'Smart Intent Routing · 智能意图路由 (smart)' },
  { value: 'order', label: 'Failover Priority · 故障优先切换 (order)' },
  { value: 'rotate', label: 'Round Robin · 轮询均衡 (rotate)' },
  { value: 'usage', label: 'Usage Balanced · 用量亲和均衡 (usage)' },
  { value: 'cheapest', label: 'Cost Optimized · 最低成本优先 (cheapest)' },
  { value: 'fastest', label: 'Lowest Latency · 最低延迟优先 (fastest)' },
];

const API_MODE_OPTIONS: Array<{ value: RealMagpieApiMode; label: string }> = [
  { value: 'chat_completions', label: 'OpenAI Chat Completions (/chat/completions)' },
  { value: 'codex_responses', label: 'OpenAI Responses API (/responses)' },
  { value: 'anthropic_messages', label: 'Anthropic Messages (/messages)' },
  { value: 'gemini_generate_content', label: 'Google Gemini / Vertex AI' },
];

export function MagpieGatewayPanel({
  embedded = false,
  asModal = false,
  onClose,
}: MagpieGatewayPanelProps = {}): React.JSX.Element {
  const magpieConfig = useAiWorkspaceStore((s) => s.magpieConfig);
  const magpieMeta = useAiWorkspaceStore((s) => s.magpieMeta);
  const magpieSubscriptions = useAiWorkspaceStore((s) => s.magpieSubscriptions);
  const magpieUsage = useAiWorkspaceStore((s) => s.magpieUsage);
  const maskPreview = useAiWorkspaceStore((s) => s.maskPreview);
  const modelsCatalog = useAiWorkspaceStore((s) => s.modelsCatalog);
  const modelsCatalogError = useAiWorkspaceStore((s) => s.modelsCatalogError);

  const loadMagpie = useAiWorkspaceStore((s) => s.loadMagpie);
  const updateMagpie = useAiWorkspaceStore((s) => s.updateMagpie);
  const loadModelsCatalog = useAiWorkspaceStore((s) => s.loadModelsCatalog);
  const syncMagpieSubscriptions = useAiWorkspaceStore((s) => s.syncMagpieSubscriptions);
  const activateMagpieSubscription = useAiWorkspaceStore((s) => s.activateMagpieSubscription);
  const upsertMagpieGroup = useAiWorkspaceStore((s) => s.upsertMagpieGroup);
  const deleteMagpieGroup = useAiWorkspaceStore((s) => s.deleteMagpieGroup);
  const probeMagpieProvider = useAiWorkspaceStore((s) => s.probeMagpieProvider);
  const previewMask = useAiWorkspaceStore((s) => s.previewMask);

  const pushToast = useUiStore((s) => s.pushToast);

  // Add / Edit provider form state
  const [selectedPresetId, setSelectedPresetId] = useState('openai');
  const [providerId, setProviderId] = useState('');
  const [providerName, setProviderName] = useState('');
  const [apiMode, setApiMode] = useState<RealMagpieApiMode>('chat_completions');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [defaultModel, setDefaultModel] = useState('gpt-4o-mini');
  const [apiKey, setApiKey] = useState('');
  const [savingProvider, setSavingProvider] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);

  // Per-provider probe status
  const [probeBusyId, setProbeBusyId] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<
    Record<string, { ok: boolean; latency_ms?: number; models?: string[]; error?: string }>
  >({});

  // models.dev catalog search
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogFilter, setCatalogFilter] = useState('');

  // Client-scoped subscription sync state
  const [showSubSync, setShowSubSync] = useState(false);
  const [subSyncJson, setSubSyncJson] = useState('');
  const [subSyncBusy, setSubSyncBusy] = useState(false);
  const [subSyncError, setSubSyncError] = useState<string | null>(null);

  // Routing group form state
  const [groupName, setGroupName] = useState('');
  const [groupStrategy, setGroupStrategy] = useState<MagpieRoutingStrategy>('smart');
  const [groupModelsText, setGroupModelsText] = useState('');
  const [savingGroup, setSavingGroup] = useState(false);

  // Server-backed PII masking tester
  const [maskSample, setMaskSample] = useState(
    'Contact ops@example.com or +1-415-555-0199 with key sk-test-sample-placeholder-123456',
  );
  const [maskBusy, setMaskBusy] = useState(false);
  const [maskError, setMaskError] = useState<string | null>(null);

  useEffect(() => {
    void loadMagpie().catch(() => undefined);
    void loadModelsCatalog(false).catch(() => undefined);
  }, [loadMagpie, loadModelsCatalog]);

  const presets = useMemo(
    () => (magpieConfig?.presets ?? []).filter((p) => ALLOWED_API_MODES.has(p.api_mode)),
    [magpieConfig?.presets],
  );

  const providers = useMemo(
    () => (magpieConfig?.providers ?? []).filter((p) => ALLOWED_API_MODES.has(p.api_mode)),
    [magpieConfig?.providers],
  );

  const filteredCatalogEntries = useMemo(() => {
    if (!modelsCatalog?.providers) return [];
    const q = catalogFilter.trim().toLowerCase();
    return Object.entries(modelsCatalog.providers)
      .map(([provId, models]) => {
        if (!q) return [provId, models.slice(0, 8)] as const;
        if (provId.toLowerCase().includes(q)) return [provId, models.slice(0, 12)] as const;
        const matched = models.filter((m) => m.toLowerCase().includes(q));
        return [provId, matched.slice(0, 12)] as const;
      })
      .filter(([, models]) => models.length > 0)
      .slice(0, 24);
  }, [modelsCatalog, catalogFilter]);

  const handleSelectPreset = (nextPresetId: string) => {
    setSelectedPresetId(nextPresetId);
    const found = presets.find((p) => p.id === nextPresetId);
    if (found) {
      setProviderId(found.id);
      setProviderName(found.name);
      setApiMode(toRealApiMode(found.api_mode));
      setBaseUrl(found.base_url);
      setDefaultModel(found.default_model);
    }
  };

  const handleLoadProviderIntoForm = (prov: MagpieProviderView) => {
    setProviderId(prov.provider_id);
    setProviderName(prov.name);
    setApiMode(toRealApiMode(prov.api_mode));
    setBaseUrl(prov.base_url);
    setDefaultModel(prov.default_model);
    setApiKey('');
    setProviderError(null);
  };

  const handleSaveProvider = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setProviderError(null);
    const cleanName = providerName.trim() || selectedPresetId || 'Custom Provider';
    const cleanId =
      providerId.trim() ||
      cleanName
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '') ||
      `prov_${Date.now().toString(36)}`;
    const cleanUrl = baseUrl.trim();
    const cleanModel = defaultModel.trim();
    if (!cleanUrl || !cleanModel) {
      setProviderError('Base URL and Default Model are required · 请填写接口地址与默认模型');
      return;
    }

    setSavingProvider(true);
    try {
      await updateMagpie({
        upsertProvider: {
          provider_id: cleanId,
          preset_id: selectedPresetId || undefined,
          name: cleanName,
          api_mode: apiMode,
          base_url: cleanUrl,
          default_model: cleanModel,
          api_key: apiKey.trim() || undefined,
          enabled: true,
          activate: true,
        },
      });
      setApiKey('');
      pushToast(`Saved & activated ${cleanName} (${cleanModel})`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setProviderError(msg);
      pushToast(msg, 'error');
    } finally {
      setSavingProvider(false);
    }
  };

  const handleActivateProvider = async (prov: MagpieProviderView) => {
    try {
      await updateMagpie({
        activeProvider: prov.provider_id,
        activeModel: prov.default_model,
      });
      pushToast(`Active provider set to ${prov.name} (${prov.default_model})`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleProbeProvider = async (id: string) => {
    setProbeBusyId(id);
    try {
      const res = await probeMagpieProvider(id);
      setProbeResults((prev) => ({ ...prev, [id]: res }));
      pushToast(
        res.ok
          ? `Probe OK (${res.latency_ms ?? 0}ms, ${res.models?.length ?? 0} models)`
          : `Probe failed: ${res.error ?? 'unreachable'}`,
        res.ok ? 'success' : 'error',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setProbeResults((prev) => ({ ...prev, [id]: { ok: false, error: msg } }));
      pushToast(msg, 'error');
    } finally {
      setProbeBusyId(null);
    }
  };

  const handleDeleteProvider = async (id: string) => {
    try {
      await updateMagpie({ deleteProviderId: id });
      pushToast(`Deleted provider ${id}`, 'info');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleRefreshCatalog = async () => {
    setCatalogLoading(true);
    try {
      const cat = await loadModelsCatalog(true);
      if (cat) {
        pushToast(
          `Loaded ${Object.keys(cat.providers).length} providers from ${cat.source}`,
          'success',
        );
      }
    } finally {
      setCatalogLoading(false);
    }
  };

  const handleSyncSubscriptions = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setSubSyncError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(subSyncJson);
    } catch {
      setSubSyncError('Invalid JSON payload · 请输入合法的 JSON 数组');
      return;
    }
    const list = Array.isArray(parsed)
      ? (parsed as Array<Record<string, unknown>>)
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { subscriptions?: unknown }).subscriptions)
        ? ((parsed as { subscriptions: Array<Record<string, unknown>> }).subscriptions)
        : null;
    if (!list) {
      setSubSyncError('Provide a JSON array of subscriptions · 请提供订阅凭证数组');
      return;
    }
    setSubSyncBusy(true);
    try {
      await syncMagpieSubscriptions(list, true);
      setSubSyncJson('');
      setShowSubSync(false);
      pushToast(`Synced ${list.length} user-scoped subscription(s)`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSubSyncError(msg);
      pushToast(msg, 'error');
    } finally {
      setSubSyncBusy(false);
    }
  };

  const handleCreateRoutingGroup = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const cleanName = groupName.trim();
    const models = groupModelsText
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!cleanName || models.length === 0) {
      pushToast('Enter a group name and at least one model target', 'warning');
      return;
    }
    setSavingGroup(true);
    try {
      await upsertMagpieGroup({ name: cleanName, strategy: groupStrategy, models });
      setGroupName('');
      setGroupModelsText('');
      pushToast(`Saved routing group "${cleanName}"`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSavingGroup(false);
    }
  };

  const handleMaskToggle = async (
    key: 'enabled' | 'mask_secrets' | 'mask_personal',
    nextVal: boolean,
  ) => {
    const cur = magpieConfig?.masking ?? {
      enabled: true,
      mask_secrets: true,
      mask_personal: true,
      custom_words: [],
      allow_list: [],
      default_action: 'mask' as const,
    };
    try {
      await updateMagpie({ masking: { ...cur, [key]: nextVal } });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleTestMask = async () => {
    if (!maskSample.trim()) return;
    setMaskError(null);
    setMaskBusy(true);
    try {
      await previewMask(maskSample);
    } catch (err) {
      setMaskError(err instanceof Error ? err.message : String(err));
    } finally {
      setMaskBusy(false);
    }
  };

  const hasConfiguredProvider = Boolean(
    magpieMeta?.hasConfiguredProvider ?? providers.some((p) => p.enabled !== false),
  );

  const content = (
    <div
      id={DOM_IDS.MAGPIE_GATEWAY_PANEL}
      className={embedded ? 'tg-magpie-embedded' : 'tg-ai-workspace'}
    >
      {/* Header & Tenant Isolation Status */}
      <div className={embedded ? 'tg-ai-card' : 'tg-ai-workspace__header'}>
        <div className="tg-ai-workspace__title-group">
          <h3 className="tg-ai-workspace__title">
            <span>🧭</span>
            <span>Magpie v1.6 LLM Gateway · 喜鹊模型网关</span>
          </h3>
          <div className="tg-ai-row">
            <span className="tg-ai-badge tg-ai-badge--info">
              🔐 User-Scoped ChaCha20 Vault · 独立加密隔离
            </span>
            {hasConfiguredProvider ? (
              <span className="tg-ai-badge tg-ai-badge--success">
                Active: {magpieConfig?.activeProvider || providers[0]?.provider_id} (
                {magpieConfig?.activeModel || providers[0]?.default_model})
              </span>
            ) : (
              <span className="tg-ai-badge tg-ai-badge--warning">
                未配置默认模型 · No Provider Configured (503 Fail-Closed)
              </span>
            )}
          </div>
        </div>
        <div className="tg-ai-workspace__actions">
          <button
            type="button"
            className="tg-btn tg-btn--ghost"
            onClick={() => void loadMagpie()}
          >
            ↻ Refresh · 刷新
          </button>
          {onClose && (
            <button type="button" className="tg-btn tg-btn--ghost" onClick={onClose}>
              ✕ Close · 关闭
            </button>
          )}
        </div>
      </div>

      <div className={embedded ? '' : 'tg-ai-workspace__body'} style={embedded ? { display: 'flex', flexDirection: 'column', gap: 14 } : undefined}>
        {/* 1. Live models.dev 2-Tier Catalog Browser */}
        <section className="tg-ai-card">
          <div className="tg-ai-card__header">
            <h4 className="tg-ai-card__title">📚 Live models.dev Catalog · 实时模型目录</h4>
            <div className="tg-ai-row">
              {modelsCatalog && (
                <span className="tg-ai-badge tg-ai-badge--accent">
                  source: {modelsCatalog.source} · {Object.keys(modelsCatalog.providers).length} providers
                </span>
              )}
              <button
                type="button"
                className="tg-btn tg-btn--secondary"
                disabled={catalogLoading}
                onClick={() => void handleRefreshCatalog()}
              >
                {catalogLoading ? 'Refreshing…' : 'Refresh Catalog · 刷新 models.dev 目录'}
              </button>
            </div>
          </div>

          <div className="tg-ai-field">
            <input
              type="text"
              value={catalogFilter}
              onChange={(e) => setCatalogFilter(e.target.value)}
              placeholder="Filter providers or models (e.g. openai, anthropic, gemini, gpt-4o, claude)..."
              aria-label="Filter models.dev catalog"
            />
          </div>

          {modelsCatalogError && (
            <div role="alert" className="tg-secret-leak-alert">
              models.dev catalog unavailable: {modelsCatalogError}
            </div>
          )}

          {filteredCatalogEntries.length > 0 ? (
            <div className="tg-catalog-grid">
              {filteredCatalogEntries.map(([provKey, models]) => (
                <div key={provKey} className="tg-catalog-item">
                  <strong style={{ fontSize: 12 }}>{provKey}</strong>
                  <div className="tg-catalog-item__models">
                    {models.map((modelId) => (
                      <button
                        key={`${provKey}:${modelId}`}
                        type="button"
                        className="tg-catalog-model-btn"
                        onClick={() => {
                          const matchingPreset = presets.find(
                            (p) => p.id.toLowerCase() === provKey.toLowerCase(),
                          );
                          if (matchingPreset) {
                            handleSelectPreset(matchingPreset.id);
                          } else {
                            setProviderId(provKey);
                            setProviderName(provKey);
                          }
                          setDefaultModel(modelId);
                          pushToast(`Selected ${provKey} / ${modelId}`, 'info');
                        }}
                      >
                        {modelId}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            !modelsCatalogError && (
              <div className="tg-ai-empty">
                No catalog models matched. Click Refresh Catalog to query live models.dev metadata.
              </div>
            )
          )}
        </section>

        {/* 2. Add / Edit Per-User Encrypted Provider */}
        <section className="tg-ai-card">
          <div className="tg-ai-card__header">
            <h4 className="tg-ai-card__title">➕ Add / Update AI Provider · 添加或更新模型供应商</h4>
            <span className="tg-ai-badge">Encrypted with per-user HKDF + ChaCha20-Poly1305</span>
          </div>

          <form onSubmit={(e) => void handleSaveProvider(e)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="tg-ai-field-grid">
              <label className="tg-ai-field">
                <span>Preset · 预设 ({presets.length})</span>
                <select
                  value={selectedPresetId}
                  onChange={(e) => handleSelectPreset(e.target.value)}
                >
                  <option value="">Custom Provider · 自定义</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.id})
                    </option>
                  ))}
                </select>
              </label>

              <label className="tg-ai-field">
                <span>Provider ID · 供应商标识</span>
                <input
                  type="text"
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                  placeholder="e.g. openai, anthropic, openrouter"
                />
              </label>

              <label className="tg-ai-field">
                <span>Display Name · 显示名称</span>
                <input
                  type="text"
                  value={providerName}
                  onChange={(e) => setProviderName(e.target.value)}
                  placeholder="e.g. OpenAI Production"
                />
              </label>

              <label className="tg-ai-field">
                <span>API Protocol · 协议格式</span>
                <select
                  value={apiMode}
                  onChange={(e) => setApiMode(e.target.value as RealMagpieApiMode)}
                >
                  {API_MODE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="tg-ai-field">
                <span>Base URL · 接口地址</span>
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  required
                />
              </label>

              <label className="tg-ai-field">
                <span>Default Model · 默认模型</span>
                <input
                  type="text"
                  value={defaultModel}
                  onChange={(e) => setDefaultModel(e.target.value)}
                  placeholder="gpt-4o-mini"
                  required
                />
              </label>

              <label className="tg-ai-field">
                <span>API Key (Redacted at Rest) · 密钥</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  autoComplete="off"
                />
              </label>
            </div>

            {providerError && (
              <div role="alert" className="tg-secret-leak-alert">
                {providerError}
              </div>
            )}

            <div className="tg-ai-row">
              <button
                type="submit"
                className="tg-btn tg-btn--primary"
                disabled={savingProvider}
              >
                {savingProvider ? 'Saving…' : 'Save & Activate · 保存并启用'}
              </button>
            </div>
          </form>
        </section>

        {/* 3. Configured Multi-Provider Cards */}
        <section className="tg-ai-card">
          <div className="tg-ai-card__header">
            <h4 className="tg-ai-card__title">
              🧩 Configured Providers · 已配置供应商 ({providers.length})
            </h4>
          </div>

          {providers.length === 0 ? (
            <div className="tg-ai-empty">
              No AI providers configured for this account yet. Add a real upstream provider above to enable Fabushi AI & Talk Mode. · 当前账号尚未配置任何模型供应商。
            </div>
          ) : (
            <div className="tg-ai-grid">
              {providers.map((prov) => {
                const isActive = magpieConfig?.activeProvider === prov.provider_id;
                const probe = probeResults[prov.provider_id];
                return (
                  <div key={prov.provider_id} className="tg-ai-card tg-ai-card--elevated">
                    <div className="tg-ai-card__header">
                      <strong>{prov.name}</strong>
                      <span
                        className={`tg-ai-badge ${isActive ? 'tg-ai-badge--success' : ''}`}
                      >
                        {isActive ? 'Active · 生效中' : prov.api_mode}
                      </span>
                    </div>
                    <div className="tg-ai-workspace__subtitle">
                      ID: <code>{prov.provider_id}</code> · Model: <code>{prov.default_model}</code>
                    </div>
                    <div className="tg-ai-workspace__subtitle">
                      Endpoint: <code>{prov.base_url}</code>
                    </div>
                    <div className="tg-ai-workspace__subtitle">
                      API Key: <code>{prov.masked_key || (prov.has_api_key ? '••••••••' : 'None')}</code>
                    </div>

                    {probe && (
                      <div
                        className={`tg-ai-badge ${
                          probe.ok ? 'tg-ai-badge--success' : 'tg-ai-badge--danger'
                        }`}
                      >
                        {probe.ok
                          ? `Reachable (${probe.latency_ms ?? 0}ms · ${probe.models?.length ?? 0} models)`
                          : `Unreachable: ${probe.error ?? 'Probe failed'}`}
                      </div>
                    )}

                    <div className="tg-ai-row">
                      {!isActive && (
                        <button
                          type="button"
                          className="tg-btn tg-btn--primary"
                          onClick={() => void handleActivateProvider(prov)}
                        >
                          Activate · 启用
                        </button>
                      )}
                      <button
                        type="button"
                        className="tg-btn tg-btn--secondary"
                        disabled={probeBusyId === prov.provider_id}
                        onClick={() => void handleProbeProvider(prov.provider_id)}
                      >
                        {probeBusyId === prov.provider_id
                          ? 'Probing…'
                          : 'Probe Connectivity · 连通性检测'}
                      </button>
                      <button
                        type="button"
                        className="tg-btn tg-btn--ghost"
                        onClick={() => handleLoadProviderIntoForm(prov)}
                      >
                        Edit · 编辑
                      </button>
                      <button
                        type="button"
                        className="tg-btn tg-btn--danger"
                        onClick={() => void handleDeleteProvider(prov.provider_id)}
                      >
                        Delete · 删除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 4. Client-Scoped Subscriptions */}
        <section className="tg-ai-card">
          <div className="tg-ai-card__header">
            <h4 className="tg-ai-card__title">
              🔑 Client-Scoped Subscriptions · 客户端同步订阅 ({magpieSubscriptions.length})
            </h4>
            <button
              type="button"
              className="tg-btn tg-btn--secondary"
              onClick={() => setShowSubSync((v) => !v)}
            >
              {showSubSync ? 'Hide Form · 收起' : 'Sync Subscription JSON · 同步订阅凭证'}
            </button>
          </div>

          {showSubSync && (
            <form onSubmit={(e) => void handleSyncSubscriptions(e)} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label className="tg-ai-field">
                <span>Subscription JSON Payload (encrypted per-user on server)</span>
                <textarea
                  rows={4}
                  value={subSyncJson}
                  onChange={(e) => setSubSyncJson(e.target.value)}
                  placeholder='[{"account":{"id":"sub_primary","kind":"codex_chatgpt","label":"My Subscription","base_url":"https://api.openai.com/v1","default_model":"gpt-4o-mini"},"access_token":"..."}]'
                />
              </label>
              {subSyncError && (
                <div role="alert" className="tg-secret-leak-alert">
                  {subSyncError}
                </div>
              )}
              <div className="tg-ai-row">
                <button type="submit" className="tg-btn tg-btn--primary" disabled={subSyncBusy}>
                  {subSyncBusy ? 'Syncing…' : 'Sync & Encrypt · 加密同步'}
                </button>
              </div>
            </form>
          )}

          {magpieSubscriptions.length === 0 ? (
            <div className="tg-ai-empty">
              No client-synced subscriptions yet. Server never reads host OS credentials. · 暂无同步订阅。
            </div>
          ) : (
            <div className="tg-ai-grid">
              {magpieSubscriptions.map((sub) => {
                const id = String(sub.sub_id ?? sub.id ?? '');
                const label = String(sub.label ?? sub.plan_name ?? id);
                const active = Boolean(sub.active);
                const model = typeof sub.default_model === 'string' ? sub.default_model : '';
                return (
                  <div key={id} className="tg-ai-card tg-ai-card--elevated">
                    <div className="tg-ai-row tg-ai-row--between">
                      <strong>{label}</strong>
                      <span className={`tg-ai-badge ${active ? 'tg-ai-badge--success' : ''}`}>
                        {active ? 'Active' : String(sub.kind ?? 'subscription')}
                      </span>
                    </div>
                    <div className="tg-ai-workspace__subtitle">
                      ID: <code>{id}</code> {model ? `· Model: ${model}` : ''}
                    </div>
                    {!active && (
                      <button
                        type="button"
                        className="tg-btn tg-btn--secondary"
                        onClick={() => void activateMagpieSubscription(id, model || undefined)}
                      >
                        Activate · 启用
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 5. Routing Strategy & Routing Groups CRUD */}
        <section className="tg-ai-card">
          <div className="tg-ai-card__header">
            <h4 className="tg-ai-card__title">🔀 Routing Strategy & Groups · 路由策略与分组</h4>
          </div>

          <label className="tg-ai-field">
            <span>Global Routing Strategy · 全局路由策略</span>
            <select
              value={magpieConfig?.routingStrategy ?? 'smart'}
              onChange={(e) => void updateMagpie({ routingStrategy: e.target.value })}
            >
              {ROUTING_STRATEGY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <form onSubmit={(e) => void handleCreateRoutingGroup(e)} className="tg-ai-field-grid">
            <label className="tg-ai-field">
              <span>Group Name · 分组名称</span>
              <input
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="e.g. Primary Code Routing"
              />
            </label>
            <label className="tg-ai-field">
              <span>Group Strategy · 分组策略</span>
              <select
                value={groupStrategy}
                onChange={(e) => setGroupStrategy(e.target.value as MagpieRoutingStrategy)}
              >
                {ROUTING_STRATEGY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.value}
                  </option>
                ))}
              </select>
            </label>
            <label className="tg-ai-field">
              <span>Model Targets (comma separated) · 目标模型列表</span>
              <input
                type="text"
                value={groupModelsText}
                onChange={(e) => setGroupModelsText(e.target.value)}
                placeholder="gpt-4o-mini, claude-3-5-sonnet"
              />
            </label>
            <div className="tg-ai-row" style={{ alignItems: 'flex-end' }}>
              <button type="submit" className="tg-btn tg-btn--secondary" disabled={savingGroup}>
                {savingGroup ? 'Saving…' : '+ Add Group · 添加路由组'}
              </button>
            </div>
          </form>

          {(magpieConfig?.routingGroups ?? []).length > 0 && (
            <div className="tg-ai-grid">
              {(magpieConfig?.routingGroups ?? []).map((grp) => (
                <div key={grp.id} className="tg-ai-card tg-ai-card--elevated">
                  <div className="tg-ai-row tg-ai-row--between">
                    <strong>{grp.name}</strong>
                    <span className="tg-ai-badge tg-ai-badge--accent">{grp.strategy}</span>
                  </div>
                  <div className="tg-ai-workspace__subtitle">
                    Targets: {grp.members.map((m) => m.target).join(', ') || 'None'}
                  </div>
                  <button
                    type="button"
                    className="tg-btn tg-btn--danger"
                    onClick={() => void deleteMagpieGroup(grp.id)}
                  >
                    Delete · 删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 6. Server-Backed Outbound PII Privacy Masking */}
        <section className="tg-ai-card">
          <div className="tg-ai-card__header">
            <h4 className="tg-ai-card__title">🛡️ Outbound PII Privacy Masking · 服务端隐私脱敏</h4>
          </div>

          <div className="tg-ai-row">
            <label className="tg-ai-row" style={{ cursor: 'pointer', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={Boolean(magpieConfig?.masking.enabled ?? true)}
                onChange={(e) => void handleMaskToggle('enabled', e.target.checked)}
              />
              <span>Enable Masking · 启用脱敏</span>
            </label>
            <label className="tg-ai-row" style={{ cursor: 'pointer', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={Boolean(magpieConfig?.masking.mask_secrets ?? true)}
                onChange={(e) => void handleMaskToggle('mask_secrets', e.target.checked)}
              />
              <span>Mask API Keys / Secrets · 脱敏密钥</span>
            </label>
            <label className="tg-ai-row" style={{ cursor: 'pointer', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={Boolean(magpieConfig?.masking.mask_personal ?? true)}
                onChange={(e) => void handleMaskToggle('mask_personal', e.target.checked)}
              />
              <span>Mask Email / Phone · 脱敏邮箱手机</span>
            </label>
          </div>

          <div className="tg-ai-field">
            <textarea
              rows={2}
              value={maskSample}
              onChange={(e) => setMaskSample(e.target.value)}
              aria-label="PII Masking Sample Input"
            />
          </div>

          <div className="tg-ai-row">
            <button
              type="button"
              className="tg-btn tg-btn--secondary"
              disabled={maskBusy}
              onClick={() => void handleTestMask()}
            >
              {maskBusy ? 'Testing…' : 'Test Masking · 测试脱敏'}
            </button>
          </div>

          {maskError && (
            <div role="alert" className="tg-secret-leak-alert">
              Server PII masking preview failed: {maskError}
            </div>
          )}

          {maskPreview && (
            <div className="tg-ai-card tg-ai-card--elevated">
              <div className="tg-ai-row tg-ai-row--between">
                <strong>Server Masked Preview · 服务端脱敏结果</strong>
                <span className="tg-ai-badge tg-ai-badge--info">
                  Hits: {maskPreview.hit_count} {maskPreview.blocked ? '· BLOCKED' : ''}
                </span>
              </div>
              <pre className="tg-ai-code-block">{maskPreview.masked_text}</pre>
            </div>
          )}
        </section>

        {/* 7. Token & Cost Usage Ledger */}
        {magpieUsage && (
          <section className="tg-ai-card">
            <div className="tg-ai-card__header">
              <h4 className="tg-ai-card__title">📊 Token & Usage Ledger · 用量账本</h4>
            </div>
            <div className="tg-ai-row">
              <span className="tg-ai-badge">Requests: {magpieUsage.total_requests}</span>
              <span className="tg-ai-badge">Prompt: {magpieUsage.prompt_tokens}</span>
              <span className="tg-ai-badge">Completion: {magpieUsage.completion_tokens}</span>
              <span className="tg-ai-badge">Total Tokens: {magpieUsage.total_tokens}</span>
              <span className="tg-ai-badge">Masked PII: {magpieUsage.masked_pii_count}</span>
            </div>
          </section>
        )}
      </div>
    </div>
  );

  if (asModal) {
    return (
      <div
        className="tg-modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label="Magpie LLM Gateway"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose?.();
        }}
      >
        <div
          className="tg-modal-card"
          style={{ width: 'min(920px, 95vw)', height: 'min(86vh, 840px)', padding: 0, overflow: 'hidden' }}
        >
          {content}
        </div>
      </div>
    );
  }

  return content;
}
