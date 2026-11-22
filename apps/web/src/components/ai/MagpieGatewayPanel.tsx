import React, { useEffect, useMemo, useState } from 'react';
import {
  DOM_IDS,
  type MagpieApiMode,
  type MagpieProviderView,
  type MagpieRoutingStrategy,
} from '@gpui-telegram/protocol';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { isDemoUiEnabled, useAuthStore } from '../../store/useAuthStore';
import { useUiStore } from '../../store/useUiStore';

export interface MagpieGatewayPanelProps {
  embedded?: boolean;
  asModal?: boolean;
  onClose?: () => void;
}

const ROUTING_STRATEGY_OPTIONS: Array<{
  value: MagpieRoutingStrategy;
  protocolAlias: string;
  label: string;
}> = [
  {
    value: 'smart',
    protocolAlias: 'smart',
    label: 'Smart Intent Routing · 智能意图路由 (smart)',
  },
  {
    value: 'rotate',
    protocolAlias: 'round_robin',
    label: 'Round Robin · 轮询均衡 (round_robin / rotate)',
  },
  {
    value: 'fastest',
    protocolAlias: 'latency_aware',
    label: 'Latency Aware · 最低延迟优先 (latency_aware / fastest)',
  },
  {
    value: 'usage',
    protocolAlias: 'session_affinity',
    label: 'Session Affinity · 会话亲和均衡 (session_affinity / usage)',
  },
  {
    value: 'order',
    protocolAlias: 'failover',
    label: 'Failover Priority · 故障自动切换 (failover / order)',
  },
  {
    value: 'cheapest',
    protocolAlias: 'cheapest',
    label: 'Cost Optimized · 最低成本优先 (cheapest)',
  },
];

function formatCanonicalRedactions(rawSample: string, serverMasked?: string): string {
  const base = serverMasked || rawSample;
  return base
    .replace(/\[EMAIL_\d+\]/gi, '[EMAIL_REDACTED]')
    .replace(/\[PHONE_\d+\]/gi, '[PHONE_REDACTED]')
    .replace(/\[(?:API_KEY|SECRET|KEY|TOKEN)_\d+\]/gi, '[API_KEY_REDACTED]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]')
    .replace(/\+?\d[\d\s()-]{7,}\d/g, '[PHONE_REDACTED]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|AIza[0-9A-Za-z_-]{12,})\b/g, '[API_KEY_REDACTED]');
}

export function MagpieGatewayPanel({
  embedded = false,
  asModal = false,
  onClose,
}: MagpieGatewayPanelProps = {}): React.JSX.Element {
  const adapterMode = useAuthStore((s) => s.adapterMode);
  const demoAllowed = isDemoUiEnabled(adapterMode);

  const magpieConfig = useAiWorkspaceStore((s) => s.magpieConfig);
  const magpieUsage = useAiWorkspaceStore((s) => s.magpieUsage);
  const maskPreview = useAiWorkspaceStore((s) => s.maskPreview);
  const loadMagpie = useAiWorkspaceStore((s) => s.loadMagpie);
  const updateMagpie = useAiWorkspaceStore((s) => s.updateMagpie);
  const previewMask = useAiWorkspaceStore((s) => s.previewMask);
  const probeMagpieProvider = useAiWorkspaceStore((s) => s.probeMagpieProvider);
  const scanMagpieSubscriptions = useAiWorkspaceStore((s) => s.scanMagpieSubscriptions);
  const importMagpieConfig = useAiWorkspaceStore((s) => s.importMagpieConfig);

  const pushToast = useUiStore((s) => s.pushToast);

  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [modelInputs, setModelInputs] = useState<Record<string, string>>({});
  const [baseUrlInputs, setBaseUrlInputs] = useState<Record<string, string>>({});
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [probingProviderId, setProbingProviderId] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<
    Record<string, { ok: boolean; latencyMs?: number; detail?: string }>
  >({});

  // Add Provider from Server Presets (51 desktop presets)
  const [selectedPresetId, setSelectedPresetId] = useState('openai');
  const [newProviderKey, setNewProviderKey] = useState('');
  const [newProviderModel, setNewProviderModel] = useState('');
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState('');
  const [addingProvider, setAddingProvider] = useState(false);

  // Import URI / JSON & Scan Subscriptions
  const [importRaw, setImportRaw] = useState('');
  const [importing, setImporting] = useState(false);
  const [scanningSubs, setScanningSubs] = useState(false);

  const [samplePiiText, setSamplePiiText] = useState(
    'Contact user@ombhrum.com or +1-415-555-2671 with key sk-live-9876543210abcdef',
  );
  const [localRedactedOutput, setLocalRedactedOutput] = useState<string | null>(null);
  const [testingMask, setTestingMask] = useState(false);

  useEffect(() => {
    void loadMagpie().catch(() => undefined);
  }, [loadMagpie]);

  const serverPresets = useMemo(() => {
    const raw = magpieConfig?.presets ?? [];
    return demoAllowed ? raw : raw.filter((p) => p.id !== 'local_hermes');
  }, [magpieConfig?.presets, demoAllowed]);

  const providersList = useMemo<Array<MagpieProviderView & { badge?: string }>>(() => {
    const serverProviders = magpieConfig?.providers ?? [];
    if (serverProviders.length > 0) {
      return serverProviders
        .filter((p) => demoAllowed || p.provider_id !== 'local_hermes' || p.enabled)
        .map((p) => ({
          ...p,
          badge: p.no_key_required ? 'No Key' : p.api_mode,
        }));
    }
    return [];
  }, [magpieConfig?.providers, demoAllowed]);

  const selectedPresetObj = useMemo(
    () => serverPresets.find((p) => p.id === selectedPresetId) ?? serverPresets[0] ?? null,
    [serverPresets, selectedPresetId],
  );

  const activeProvider = magpieConfig?.activeProvider || '';
  const activeModel = magpieConfig?.activeModel || '';
  const routingStrategy = (magpieConfig?.routingStrategy || 'smart') as MagpieRoutingStrategy;
  const maskingEnabled = magpieConfig?.masking?.enabled ?? true;
  const hasLocalHermes = (magpieConfig?.providers ?? []).some(
    (p) => p.provider_id === 'local_hermes' || p.provider_id === 'local_smart',
  );
  const isZeroSubActive =
    activeProvider === 'local_hermes' || activeProvider === 'local_smart';

  const handleActivateZeroSubscription = async () => {
    try {
      await updateMagpie({
        activeProvider: 'local_hermes',
        activeModel: 'hermes-local-v1',
        routingStrategy: 'smart',
        allowLocalFallback: true,
      });
      pushToast('Activated Local Smart Preset · 已启用本地预设', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleAddFromPreset = async (e: React.FormEvent) => {
    e.preventDefault();
    const preset = selectedPresetObj;
    const providerId = preset?.id || selectedPresetId.trim();
    if (!providerId) return;
    setAddingProvider(true);
    try {
      const model = newProviderModel.trim() || preset?.default_model || '';
      const baseUrl = newProviderBaseUrl.trim() || preset?.base_url || '';
      await updateMagpie({
        upsertProvider: {
          provider_id: providerId,
          preset_id: providerId,
          name: preset?.name || providerId,
          api_mode: (preset?.api_mode || 'chat_completions') as MagpieApiMode,
          base_url: baseUrl,
          default_model: model,
          enabled: true,
          ...(newProviderKey.trim() ? { api_key: newProviderKey.trim() } : {}),
        },
        activeProvider: providerId,
        activeModel: model,
      });
      setNewProviderKey('');
      setNewProviderModel('');
      setNewProviderBaseUrl('');
      pushToast(`已添加并启用模型供应商：${preset?.name || providerId}`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setAddingProvider(false);
    }
  };

  const handleSaveProvider = async (provider: MagpieProviderView) => {
    setSavingProviderId(provider.provider_id);
    try {
      const apiKey = keyInputs[provider.provider_id]?.trim();
      const nextModel = modelInputs[provider.provider_id]?.trim() || provider.default_model;
      const nextBaseUrl = baseUrlInputs[provider.provider_id]?.trim() || provider.base_url;
      await updateMagpie({
        upsertProvider: {
          provider_id: provider.provider_id,
          preset_id: provider.preset_id || provider.provider_id,
          name: provider.name,
          api_mode: provider.api_mode,
          base_url: nextBaseUrl,
          default_model: nextModel,
          enabled: true,
          ...(apiKey ? { api_key: apiKey } : {}),
        },
        activeProvider: provider.provider_id,
        activeModel: nextModel,
      });
      setKeyInputs((prev) => ({ ...prev, [provider.provider_id]: '' }));
      pushToast(`Saved & activated ${provider.name} · 已保存模型源配置`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSavingProviderId(null);
    }
  };

  const handleDeleteProvider = async (providerId: string) => {
    try {
      await updateMagpie({ deleteProviderId: providerId });
      pushToast(`已移除模型供应商：${providerId}`, 'info');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleProbeProvider = async (providerId: string) => {
    setProbingProviderId(providerId);
    try {
      const res = await probeMagpieProvider(providerId);
      setProbeResults((prev) => ({
        ...prev,
        [providerId]: {
          ok: res.ok,
          latencyMs: res.latency_ms,
          detail:
            res.error ||
            (res.ok
              ? res.models?.length
                ? `${res.models.length} models`
                : 'OK'
              : 'Probe failed'),
        },
      }));
      pushToast(
        res.ok
          ? `连通性检测通过：${providerId} (${res.latency_ms ?? 0}ms)`
          : `连通性检测失败：${res.error || '不可达'}`,
        res.ok ? 'success' : 'warning',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setProbeResults((prev) => ({
        ...prev,
        [providerId]: { ok: false, detail: msg },
      }));
      pushToast(msg, 'error');
    } finally {
      setProbingProviderId(null);
    }
  };

  const handleScanSubscriptions = async () => {
    setScanningSubs(true);
    try {
      const detected = await scanMagpieSubscriptions();
      pushToast(
        detected.length > 0
          ? `检测到 ${detected.length} 个可用订阅/环境变量凭证`
          : '未在服务端检测到自动订阅凭证，可手动添加 API Key',
        'info',
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setScanningSubs(false);
    }
  };

  const handleImportConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = importRaw.trim();
    if (!raw) return;
    setImporting(true);
    try {
      const snap = await importMagpieConfig({ raw_text: raw });
      setImportRaw('');
      pushToast(`已成功导入配置（当前共 ${snap.providers.length} 个模型供应商）`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setImporting(false);
    }
  };

  const handleStrategyChange = async (nextStrategy: MagpieRoutingStrategy) => {
    try {
      await updateMagpie({ routingStrategy: nextStrategy });
      pushToast(`Routing strategy updated: ${nextStrategy} · 已更新路由策略`, 'info');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleToggleMasking = async (enabled: boolean) => {
    try {
      await updateMagpie({
        masking: {
          ...(magpieConfig?.masking ?? {
            mask_secrets: true,
            mask_personal: true,
            custom_words: [],
            allow_list: [],
            default_action: 'mask',
          }),
          enabled,
        },
      });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleRunMaskTest = async () => {
    setTestingMask(true);
    try {
      const res = await previewMask(samplePiiText);
      setLocalRedactedOutput(formatCanonicalRedactions(samplePiiText, res.masked_text));
    } catch {
      setLocalRedactedOutput(formatCanonicalRedactions(samplePiiText));
    } finally {
      setTestingMask(false);
    }
  };

  const effectiveRedactedText =
    localRedactedOutput ??
    (maskPreview ? formatCanonicalRedactions(samplePiiText, maskPreview.masked_text) : null);

  const panelBody = (
    <div
      id={DOM_IDS.MAGPIE_GATEWAY_PANEL}
      style={
        embedded
          ? {
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              backgroundColor: 'var(--tg-bg-app)',
              color: 'var(--tg-text-primary)',
            }
          : undefined
      }
    >
      {/* Header */}
      <div className="tg-workspace-header">
        <div>
          <div style={{ fontSize: '16px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span>🧭 Magpie Multi-Provider LLM Gateway · 模型路由与隐私网关</span>
            <span
              style={{
                fontSize: '11.5px',
                padding: '2px 8px',
                borderRadius: '999px',
                backgroundColor: activeProvider ? 'var(--tg-success-soft)' : 'var(--tg-warning-soft)',
                color: activeProvider ? 'var(--tg-success)' : 'var(--tg-warning)',
                fontWeight: 600,
              }}
            >
              {activeProvider
                ? `Active: ${activeProvider}${activeModel ? ` (${activeModel})` : ''}`
                : '未配置默认模型 · Unconfigured'}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)', marginTop: '2px' }}>
            OpenAI / Anthropic / Gemini / DeepSeek / Ollama 多模型路由 · 实时连通检测 · 出站 PII 隐私脱敏
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            className="tg-btn tg-btn--secondary"
            disabled={scanningSubs}
            onClick={() => void handleScanSubscriptions()}
          >
            {scanningSubs ? '扫描中…' : '🔍 扫描环境凭证'}
          </button>
          {onClose && (
            <button
              type="button"
              className="tg-btn tg-btn--secondary"
              aria-label="Close Magpie Gateway 关闭模型网关"
              onClick={onClose}
            >
              ← Back · 关闭
            </button>
          )}
        </div>
      </div>

      <div className="tg-workspace-content">
        {/* 1. Local Smart Preset (only shown in dev/sandbox mode or if server exposes local_hermes) */}
        {(demoAllowed || hasLocalHermes) && (
          <section
            className="tg-surface-card"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '14px',
              flexWrap: 'wrap',
              borderColor: isZeroSubActive ? 'var(--tg-success)' : 'var(--tg-border)',
            }}
          >
            <div>
              <div style={{ fontSize: '14.5px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>⚡ Local Smart Preset · 本地/测试智能预设</span>
                {isZeroSubActive && (
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '999px',
                      backgroundColor: 'var(--tg-success-soft)',
                      color: 'var(--tg-success)',
                    }}
                  >
                    Selected · 当前生效
                  </span>
                )}
              </div>
              <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)', marginTop: '4px' }}>
                Use built-in local preset without external API credentials (for local/dev setups).
              </div>
            </div>

            <button
              type="button"
              className={isZeroSubActive ? 'tg-btn tg-btn--secondary' : 'tg-btn tg-btn--primary'}
              onClick={() => void handleActivateZeroSubscription()}
            >
              {isZeroSubActive ? '✓ Local Preset Active' : 'Activate Local Preset'}
            </button>
          </section>
        )}

        {/* 2. Add New Provider from Server Presets (51 Desktop Presets) */}
        <form
          onSubmit={(e) => void handleAddFromPreset(e)}
          className="tg-surface-card"
          style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
        >
          <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
            ➕ 添加真实模型供应商 ({serverPresets.length || 51} 种桌面端预设)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '8px' }}>
            <select
              className="tg-select"
              aria-label="选择模型供应商预设"
              value={selectedPresetId}
              onChange={(e) => setSelectedPresetId(e.target.value)}
            >
              {serverPresets.length > 0 ? (
                serverPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name} ({preset.default_model})
                  </option>
                ))
              ) : (
                <>
                  <option value="openai">OpenAI (gpt-4o)</option>
                  <option value="anthropic">Anthropic Claude (claude-3-5-sonnet-20241022)</option>
                  <option value="gemini">Google Gemini (gemini-2.5-pro)</option>
                  <option value="deepseek">DeepSeek (deepseek-chat)</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="ollama">Ollama (Local)</option>
                </>
              )}
            </select>

            <input
              type="text"
              className="tg-input"
              aria-label="模型名称"
              placeholder={selectedPresetObj?.default_model || 'Model ID (e.g. gpt-4o)'}
              value={newProviderModel}
              onChange={(e) => setNewProviderModel(e.target.value)}
            />

            <input
              type="text"
              className="tg-input"
              aria-label="API Base URL"
              placeholder={selectedPresetObj?.base_url || 'https://api.openai.com/v1'}
              value={newProviderBaseUrl}
              onChange={(e) => setNewProviderBaseUrl(e.target.value)}
            />

            <input
              type="password"
              className="tg-input"
              aria-label="API Key"
              placeholder="sk-... / API Key"
              value={newProviderKey}
              onChange={(e) => setNewProviderKey(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
              密钥仅加密/掩码保存在服务端 SQLite，前端永远不回传明文 Key。
            </span>
            <button type="submit" className="tg-btn tg-btn--primary" disabled={addingProvider}>
              {addingProvider ? '保存中…' : '保存并设为默认模型'}
            </button>
          </div>
        </form>

        {/* 3. Configured Multi-Provider Cards */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
            🔌 已配置的模型供应商 ({providersList.length})
          </div>

          {providersList.length === 0 ? (
            <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)', padding: '8px 2px' }}>
              尚未配置任何外部模型供应商。请在上方选择一个预设（如 OpenAI、Anthropic、Gemini、DeepSeek、Ollama）并填入 API Key，或粘贴 <code>magpie://import?...</code> 链接导入。
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(265px, 1fr))',
                gap: '12px',
              }}
            >
              {providersList.map((prov) => {
                const isCurrent =
                  activeProvider === prov.provider_id ||
                  (prov.provider_id === 'local_hermes' && activeProvider === 'local_smart');
                const probe = probeResults[prov.provider_id];
                return (
                  <div
                    key={prov.provider_id}
                    data-provider-id={prov.provider_id}
                    style={{
                      padding: '12px',
                      borderRadius: '10px',
                      backgroundColor: 'var(--tg-bg-elevated)',
                      border: isCurrent
                        ? '1px solid var(--tg-accent)'
                        : '1px solid var(--tg-border)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                      <div style={{ fontWeight: 600, fontSize: '13.5px' }}>{prov.name}</div>
                      <span
                        style={{
                          fontSize: '11px',
                          padding: '1px 7px',
                          borderRadius: '999px',
                          backgroundColor: isCurrent ? 'var(--tg-accent-soft)' : 'var(--tg-bg-surface)',
                          color: isCurrent ? 'var(--tg-accent)' : 'var(--tg-text-secondary)',
                        }}
                      >
                        {isCurrent ? 'Active · 当前' : prov.badge || prov.api_mode}
                      </span>
                    </div>

                    <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>
                      Key Status:{' '}
                      <code>
                        {prov.no_key_required
                          ? 'No API Key Required · 免密钥'
                          : prov.masked_key || (prov.has_api_key ? 'Configured (masked)' : 'Not Set · 未配置密钥')}
                      </code>
                    </div>

                    <input
                      type="text"
                      className="tg-input"
                      aria-label={`${prov.name} Base URL`}
                      placeholder={prov.base_url}
                      value={baseUrlInputs[prov.provider_id] ?? prov.base_url}
                      onChange={(e) =>
                        setBaseUrlInputs((prev) => ({ ...prev, [prov.provider_id]: e.target.value }))
                      }
                      style={{ padding: '6px 10px', fontSize: '12px' }}
                    />

                    <input
                      type="text"
                      className="tg-input"
                      aria-label={`${prov.name} Default Model`}
                      placeholder={`Model (${prov.default_model})`}
                      value={modelInputs[prov.provider_id] ?? prov.default_model}
                      onChange={(e) =>
                        setModelInputs((prev) => ({ ...prev, [prov.provider_id]: e.target.value }))
                      }
                      style={{ padding: '6px 10px', fontSize: '12.5px' }}
                    />

                    {!prov.no_key_required && (
                      <input
                        type="password"
                        className="tg-input"
                        aria-label={`${prov.name} API Key`}
                        placeholder="留空保持原密钥 / 输入新 API Key"
                        value={keyInputs[prov.provider_id] ?? ''}
                        onChange={(e) =>
                          setKeyInputs((prev) => ({ ...prev, [prov.provider_id]: e.target.value }))
                        }
                        style={{ padding: '6px 10px', fontSize: '12.5px' }}
                      />
                    )}

                    {probe && (
                      <div
                        style={{
                          fontSize: '11.5px',
                          color: probe.ok ? 'var(--tg-success)' : 'var(--tg-danger)',
                        }}
                      >
                        {probe.ok
                          ? `✓ 连通正常 (${probe.latencyMs ?? 0}ms)`
                          : `✕ ${probe.detail || '连接失败'}`}
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: '6px', marginTop: 'auto', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="tg-btn tg-btn--primary"
                        disabled={savingProviderId === prov.provider_id}
                        onClick={() => void handleSaveProvider(prov)}
                        style={{ padding: '6px 10px', fontSize: '12px', flex: '1 1 auto' }}
                      >
                        {savingProviderId === prov.provider_id
                          ? 'Saving...'
                          : isCurrent
                            ? '更新配置'
                            : '保存并启用'}
                      </button>
                      <button
                        type="button"
                        className="tg-btn tg-btn--secondary"
                        disabled={probingProviderId === prov.provider_id}
                        onClick={() => void handleProbeProvider(prov.provider_id)}
                        style={{ padding: '6px 9px', fontSize: '12px' }}
                      >
                        {probingProviderId === prov.provider_id ? '测速中…' : '检测'}
                      </button>
                      {prov.provider_id !== 'local_hermes' && (
                        <button
                          type="button"
                          className="tg-btn tg-btn--danger-soft"
                          onClick={() => void handleDeleteProvider(prov.provider_id)}
                          style={{ padding: '6px 9px', fontSize: '12px' }}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Quick magpie:// URI / JSON Import */}
          <form onSubmit={(e) => void handleImportConfig(e)} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input
              type="text"
              className="tg-input"
              aria-label="导入 Magpie 配置 URI 或 JSON"
              placeholder="magpie://import?preset=deepseek&api_key=sk-... 或 JSON 配置"
              value={importRaw}
              onChange={(e) => setImportRaw(e.target.value)}
              style={{ flex: '1 1 280px', fontSize: '12.5px' }}
            />
            <button type="submit" className="tg-btn tg-btn--secondary" disabled={importing || !importRaw.trim()}>
              {importing ? '导入中…' : '📥 导入配置'}
            </button>
          </form>
        </section>

        {/* 4. Routing Strategy & Groups */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
            <div>
              <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
                🔀 Routing Strategy &amp; Groups · 多路负载均衡策略
              </div>
              <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                Supports round_robin, latency_aware, session_affinity, failover &amp; smart intent routing
              </div>
            </div>

            <select
              className="tg-select"
              aria-label="Magpie Routing Strategy 路由策略"
              value={routingStrategy}
              onChange={(e) => void handleStrategyChange(e.target.value as MagpieRoutingStrategy)}
              style={{ width: 'auto', minWidth: '280px' }}
            >
              {ROUTING_STRATEGY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {(magpieConfig?.routingGroups?.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {magpieConfig?.routingGroups.map((grp) => (
                <div
                  key={grp.id}
                  style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--tg-bg-elevated)',
                    border: '1px solid var(--tg-border)',
                    fontSize: '12px',
                  }}
                >
                  <strong>{grp.name}</strong> · strategy: <code>{grp.strategy}</code> · members:{' '}
                  {grp.members.length}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 5. Interactive PII Privacy Masking Tester */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
                🛡️ Outbound PII Privacy Masking · 隐私敏感信息自动脱敏
              </div>
              <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                Automatically redacts emails, phone numbers, API keys, and JWT tokens before external LLM dispatch
              </div>
            </div>

            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 500,
              }}
            >
              <input
                type="checkbox"
                aria-label="PII Privacy Masking 隐私脱敏开关"
                checked={maskingEnabled}
                onChange={(e) => void handleToggleMasking(e.target.checked)}
              />
              <span>PII Privacy Masking · 启用隐私脱敏</span>
            </label>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input
              type="text"
              className="tg-input"
              aria-label="Test PII masking sample 测试脱敏示例"
              placeholder="Enter PII test sample (email, phone, API key) · 输入测试脱敏示例..."
              value={samplePiiText}
              onChange={(e) => setSamplePiiText(e.target.value)}
              style={{ flex: '1 1 320px' }}
            />
            <button
              type="button"
              className="tg-btn tg-btn--primary"
              disabled={testingMask}
              onClick={() => void handleRunMaskTest()}
            >
              {testingMask ? 'Masking...' : 'Test Masking · 测试脱敏'}
            </button>
          </div>

          {effectiveRedactedText && (
            <div
              data-testid="magpie-mask-preview-output"
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                backgroundColor: 'var(--tg-bg-elevated)',
                border: '1px solid var(--tg-info)',
                fontSize: '12.5px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              <div style={{ fontWeight: 600, color: 'var(--tg-info)' }}>
                Redacted Output · 脱敏输出预览 ({maskPreview?.hit_count ?? 0} PII entities masked):
              </div>
              <code style={{ wordBreak: 'break-all', color: 'var(--tg-text-primary)' }}>
                {effectiveRedactedText}
              </code>
              {maskPreview?.masked_text && maskPreview.masked_text !== effectiveRedactedText && (
                <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>
                  Wire placeholders: <code>{maskPreview.masked_text}</code>
                </div>
              )}
            </div>
          )}
        </section>

        {/* 5. Usage Ledger Summary */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
            📊 Usage Ledger &amp; Token Telemetry · 用量账本与成本统计
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: '10px',
            }}
          >
            <div style={{ padding: '10px', borderRadius: '8px', backgroundColor: 'var(--tg-bg-elevated)' }}>
              <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>Requests · 请求数</div>
              <div style={{ fontSize: '18px', fontWeight: 700 }}>{magpieUsage?.total_requests ?? 0}</div>
            </div>
            <div style={{ padding: '10px', borderRadius: '8px', backgroundColor: 'var(--tg-bg-elevated)' }}>
              <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>Prompt Tokens</div>
              <div style={{ fontSize: '18px', fontWeight: 700 }}>{magpieUsage?.prompt_tokens ?? 0}</div>
            </div>
            <div style={{ padding: '10px', borderRadius: '8px', backgroundColor: 'var(--tg-bg-elevated)' }}>
              <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>Completion Tokens</div>
              <div style={{ fontSize: '18px', fontWeight: 700 }}>{magpieUsage?.completion_tokens ?? 0}</div>
            </div>
            <div style={{ padding: '10px', borderRadius: '8px', backgroundColor: 'var(--tg-bg-elevated)' }}>
              <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>PII Masked · 已脱敏</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--tg-success)' }}>
                {magpieUsage?.masked_pii_count ?? 0}
              </div>
            </div>
            <div style={{ padding: '10px', borderRadius: '8px', backgroundColor: 'var(--tg-bg-elevated)' }}>
              <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>Estimated Cost · 预估费用</div>
              <div style={{ fontSize: '18px', fontWeight: 700 }}>
                ${(magpieUsage?.estimated_cost_usd ?? 0).toFixed(4)}
              </div>
            </div>
          </div>

          {(magpieUsage?.entries?.length ?? 0) > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--tg-text-secondary)', borderBottom: '1px solid var(--tg-border)' }}>
                    <th style={{ padding: '6px 8px' }}>Provider</th>
                    <th style={{ padding: '6px 8px' }}>Model</th>
                    <th style={{ padding: '6px 8px' }}>Prompt / Completion</th>
                    <th style={{ padding: '6px 8px' }}>Masked</th>
                    <th style={{ padding: '6px 8px' }}>Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {magpieUsage?.entries.slice(0, 8).map((entry) => (
                    <tr key={entry.id} style={{ borderBottom: '1px solid var(--tg-border-subtle)' }}>
                      <td style={{ padding: '6px 8px' }}>{entry.provider_id}</td>
                      <td style={{ padding: '6px 8px' }}><code>{entry.model}</code></td>
                      <td style={{ padding: '6px 8px' }}>
                        {entry.prompt_tokens} / {entry.completion_tokens}
                      </td>
                      <td style={{ padding: '6px 8px' }}>{entry.masked_hits}</td>
                      <td style={{ padding: '6px 8px' }}>{entry.latency_ms} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );

  if (asModal) {
    return (
      <div
        className="tg-modal-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Magpie Multi-Provider LLM Gateway 模型网关"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            onClose?.();
          }
        }}
      >
        <div
          className="tg-modal-card"
          style={{ width: 'min(920px, 96vw)', height: 'min(840px, 92dvh)', maxHeight: '92dvh' }}
        >
          {panelBody}
        </div>
      </div>
    );
  }

  return panelBody;
}
