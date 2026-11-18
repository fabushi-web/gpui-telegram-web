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

interface CanonicalProviderSpec {
  provider_id: string;
  name: string;
  api_mode: MagpieApiMode;
  base_url: string;
  default_model: string;
  no_key_required: boolean;
  badge: string;
}

const CANONICAL_PROVIDERS: CanonicalProviderSpec[] = [
  {
    provider_id: 'local_hermes',
    name: 'Local Magpie Smart · 零订阅内置模型',
    api_mode: 'local_hermes',
    base_url: 'local://magpie-smart',
    default_model: 'hermes-local-v1',
    no_key_required: true,
    badge: 'Zero-Subscription · 免密钥',
  },
  {
    provider_id: 'openai',
    name: 'OpenAI (GPT-4o / Codex)',
    api_mode: 'chat_completions',
    base_url: 'https://api.openai.com/v1',
    default_model: 'gpt-4o',
    no_key_required: false,
    badge: 'OpenAI API',
  },
  {
    provider_id: 'anthropic',
    name: 'Anthropic Claude',
    api_mode: 'anthropic_messages',
    base_url: 'https://api.anthropic.com/v1',
    default_model: 'claude-3-5-sonnet',
    no_key_required: false,
    badge: 'Anthropic Messages',
  },
  {
    provider_id: 'gemini',
    name: 'Google Gemini',
    api_mode: 'gemini_generate_content',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    default_model: 'gemini-2.5-pro',
    no_key_required: false,
    badge: 'Google AI Studio',
  },
];

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
  const magpieConfig = useAiWorkspaceStore((s) => s.magpieConfig);
  const magpieUsage = useAiWorkspaceStore((s) => s.magpieUsage);
  const maskPreview = useAiWorkspaceStore((s) => s.maskPreview);
  const loadMagpie = useAiWorkspaceStore((s) => s.loadMagpie);
  const updateMagpie = useAiWorkspaceStore((s) => s.updateMagpie);
  const previewMask = useAiWorkspaceStore((s) => s.previewMask);

  const pushToast = useUiStore((s) => s.pushToast);

  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [modelInputs, setModelInputs] = useState<Record<string, string>>({});
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [samplePiiText, setSamplePiiText] = useState(
    'Contact alice@example.com or +1-415-555-2671 with key sk-live-9876543210abcdef',
  );
  const [localRedactedOutput, setLocalRedactedOutput] = useState<string | null>(null);
  const [testingMask, setTestingMask] = useState(false);

  useEffect(() => {
    void loadMagpie().catch(() => undefined);
  }, [loadMagpie]);

  const providersList = useMemo<Array<MagpieProviderView & { badge?: string }>>(() => {
    const existingById = new Map<string, MagpieProviderView>();
    for (const p of magpieConfig?.providers ?? []) {
      existingById.set(p.provider_id.toLowerCase(), p);
    }

    const merged: Array<MagpieProviderView & { badge?: string }> = CANONICAL_PROVIDERS.map(
      (spec) => {
        const found =
          existingById.get(spec.provider_id) ||
          (spec.provider_id === 'local_hermes' ? existingById.get('local_smart') : undefined);
        if (found) {
          return { ...found, badge: spec.badge };
        }
        return {
          provider_id: spec.provider_id,
          preset_id: spec.provider_id,
          name: spec.name,
          api_mode: spec.api_mode,
          base_url: spec.base_url,
          default_model: spec.default_model,
          enabled: spec.no_key_required,
          no_key_required: spec.no_key_required,
          has_api_key: false,
          masked_key: null,
          custom_headers: {},
          updated_at_ms: 0,
          badge: spec.badge,
        };
      },
    );

    const canonicalIds = new Set(['local_hermes', 'local_smart', 'openai', 'anthropic', 'gemini']);
    for (const p of magpieConfig?.providers ?? []) {
      if (!canonicalIds.has(p.provider_id.toLowerCase())) {
        merged.push(p);
      }
    }
    return merged;
  }, [magpieConfig?.providers]);

  const activeProvider = magpieConfig?.activeProvider || 'local_hermes';
  const activeModel = magpieConfig?.activeModel || 'hermes-local-v1';
  const routingStrategy = (magpieConfig?.routingStrategy || 'smart') as MagpieRoutingStrategy;
  const maskingEnabled = magpieConfig?.masking?.enabled ?? true;
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
      pushToast('Activated Zero-Subscription Local Smart Preset · 已启用零订阅内置模型', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleSaveProvider = async (provider: MagpieProviderView) => {
    setSavingProviderId(provider.provider_id);
    try {
      const apiKey = keyInputs[provider.provider_id]?.trim();
      const nextModel = modelInputs[provider.provider_id]?.trim() || provider.default_model;
      await updateMagpie({
        upsertProvider: {
          provider_id: provider.provider_id,
          preset_id: provider.preset_id || provider.provider_id,
          name: provider.name,
          api_mode: provider.api_mode,
          base_url: provider.base_url,
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
          <div style={{ fontSize: '16px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>🧭 Magpie Multi-Provider LLM Gateway · 模型路由与隐私网关</span>
            <span
              style={{
                fontSize: '11.5px',
                padding: '2px 8px',
                borderRadius: '999px',
                backgroundColor: 'var(--tg-success-soft)',
                color: 'var(--tg-success)',
                fontWeight: 600,
              }}
            >
              Active: {activeProvider} ({activeModel})
            </span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)', marginTop: '2px' }}>
            Zero-Subscription Local Smart Engine · OpenAI / Anthropic / Gemini Failover · Outbound PII Redaction
          </div>
        </div>

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

      <div className="tg-workspace-content">
        {/* 1. Zero-Subscription Local Smart Preset */}
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
              <span>⚡ Zero-Subscription Local Smart Preset · 零订阅内置智能预设</span>
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
              Works immediately out-of-the-box with zero external API keys, zero subscription fees, and automatic local fallback.
            </div>
          </div>

          <button
            type="button"
            className={isZeroSubActive ? 'tg-btn tg-btn--secondary' : 'tg-btn tg-btn--primary'}
            onClick={() => void handleActivateZeroSubscription()}
          >
            {isZeroSubActive
              ? '✓ Zero-Subscription Local Smart Active · 已启用内置模型'
              : 'Use Zero-Subscription Local Smart Preset · 一键启用零订阅模型'}
          </button>
        </section>

        {/* 2. Multi-Provider Configuration Cards */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
            🔌 Multi-Provider Credentials &amp; Models · 多模型供应商配置 (Local / OpenAI / Anthropic / Google Gemini)
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: '12px',
            }}
          >
            {providersList.map((prov) => {
              const isCurrent =
                activeProvider === prov.provider_id ||
                (prov.provider_id === 'local_hermes' && activeProvider === 'local_smart');
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
                        : prov.masked_key || 'Not Set · 未配置密钥'}
                    </code>
                  </div>

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
                      placeholder="sk-... / API Key (stored masked on server)"
                      value={keyInputs[prov.provider_id] ?? ''}
                      onChange={(e) =>
                        setKeyInputs((prev) => ({ ...prev, [prov.provider_id]: e.target.value }))
                      }
                      style={{ padding: '6px 10px', fontSize: '12.5px' }}
                    />
                  )}

                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    disabled={savingProviderId === prov.provider_id}
                    onClick={() => void handleSaveProvider(prov)}
                    style={{ padding: '6px 10px', fontSize: '12.5px', marginTop: 'auto' }}
                  >
                    {savingProviderId === prov.provider_id
                      ? 'Saving...'
                      : isCurrent
                        ? 'Update Provider · 更新配置'
                        : 'Save & Activate · 保存并启用'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* 3. Routing Strategy & Groups */}
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

        {/* 4. Interactive PII Privacy Masking Tester */}
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
                Redacted Output · 脱敏输出预览 ({maskPreview?.hit_count ?? 3} PII entities masked):
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
