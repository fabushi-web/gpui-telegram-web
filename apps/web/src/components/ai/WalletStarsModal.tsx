import React, { useEffect, useMemo, useState } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useChatStore } from '../../store/useChatStore';
import { useUiStore } from '../../store/useUiStore';

export interface WalletStarsModalProps {
  isOpen?: boolean;
  onClose?: () => void;
}

const GIFT_PRESETS = [
  { id: 'gift_heart_50', label: '💝 Warm Heart · 50 ★', stars: 50 },
  { id: 'gift_trophy_100', label: '🏆 Golden Trophy · 100 ★', stars: 100 },
  { id: 'gift_rocket_250', label: '🚀 Launch Rocket · 250 ★', stars: 250 },
];

export function WalletStarsModal({
  isOpen,
  onClose,
}: WalletStarsModalProps = {}): React.JSX.Element | null {
  const activeModal = useUiStore((s) => s.activeModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const pushToast = useUiStore((s) => s.pushToast);

  const wallet = useAiWorkspaceStore((s) => s.wallet);
  const loadWallet = useAiWorkspaceStore((s) => s.loadWallet);
  const topUpStars = useAiWorkspaceStore((s) => s.topUpStars);
  const sendStarGift = useAiWorkspaceStore((s) => s.sendStarGift);

  const contacts = useChatStore((s) => s.contacts);
  const activeChatId = useChatStore((s) => s.activeChatId);

  const [customAmount, setCustomAmount] = useState('250');
  const [recipientUserId, setRecipientUserId] = useState<number>(1002);
  const [selectedGiftId, setSelectedGiftId] = useState(GIFT_PRESETS[0].id);
  const [giftMessage, setGiftMessage] = useState('Thank you for building clean hexagonal architecture!');
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const visible = isOpen !== undefined ? isOpen : activeModal === 'wallet_stars';

  useEffect(() => {
    if (!visible) return;
    void loadWallet().catch(() => undefined);
  }, [visible, loadWallet]);

  const recipientOptions = useMemo(() => {
    const list: Array<{ id: number; label: string }> = [];
    const seen = new Set<number>();
    for (const u of contacts) {
      const uid = u.userId ?? u.user_id;
      if (uid && !seen.has(uid)) {
        seen.add(uid);
        const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || `User #${uid}`;
        list.push({
          id: uid,
          label: `${fullName}${u.username ? ` (@${u.username})` : ''}`,
        });
      }
    }
    if (!seen.has(1002)) {
      list.push({ id: 1002, label: 'Bob (@bob_dev)' });
    }
    return list;
  }, [contacts]);

  const handleClose = () => {
    closeModal();
    onClose?.();
  };

  const handleQuickTopUp = async (amount: number) => {
    if (!Number.isFinite(amount) || amount <= 0) return;
    setBusyAction(`topup_${amount}`);
    try {
      await topUpStars(amount);
      pushToast(`Topped up +${amount} ★ Stars · 已成功充值 +${amount} 星币`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleCustomTopUp = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Math.floor(Number(customAmount));
    if (!Number.isFinite(amount) || amount <= 0) {
      pushToast('Enter a positive Stars amount · 请输入有效充值数量', 'warning');
      return;
    }
    await handleQuickTopUp(amount);
  };

  const handleSendGift = async (e: React.FormEvent) => {
    e.preventDefault();
    const preset = GIFT_PRESETS.find((g) => g.id === selectedGiftId) || GIFT_PRESETS[0];
    setBusyAction('gift');
    try {
      await sendStarGift({
        toUserId: recipientUserId,
        chatId: activeChatId ?? undefined,
        amountStars: preset.stars,
        giftId: preset.id,
        message: giftMessage.trim() || undefined,
      });
      pushToast(`Sent ${preset.stars} ★ Star Gift · 星币礼物已送出`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyAction(null);
    }
  };

  if (!visible) return null;

  const starsBalance = wallet?.stars_balance ?? wallet?.balance ?? 500;
  const tonBalance = wallet?.ton_balance || '12.50';
  const transactions = wallet?.transactions ?? [];

  return (
    <div
      id={DOM_IDS.WALLET_STARS_MODAL}
      className="tg-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Telegram Stars & TON Wallet 星币与 TON 钱包"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleClose();
        }
      }}
    >
      <div
        className="tg-modal-card"
        style={{ width: 'min(600px, 95vw)', maxHeight: '90dvh' }}
      >
        {/* Header */}
        <div className="tg-modal-header">
          <div>
            <div style={{ fontSize: '16px', fontWeight: 700 }}>
              ★ Telegram Stars &amp; TON Wallet · 星币与链上钱包
            </div>
            <div style={{ fontSize: '12px', fontWeight: 400, color: 'var(--tg-text-secondary)' }}>
              Instant Stars Top-Up · Peer Star Gifts · Mini App Invoice Payments
            </div>
          </div>
          <button
            type="button"
            className="tg-icon-btn"
            aria-label="Close Wallet 关闭钱包"
            onClick={handleClose}
          >
            ×
          </button>
        </div>

        {/* Body (Zero-purple Gold/Amber & Ocean Cyan palette!) */}
        <div className="tg-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Balance Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div
              style={{
                padding: '14px 16px',
                borderRadius: '12px',
                backgroundColor: 'var(--tg-bg-elevated)',
                border: '1px solid rgba(229, 160, 48, 0.38)',
              }}
            >
              <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)', fontWeight: 500 }}>
                Telegram Stars · 星币余额
              </div>
              <div
                style={{
                  fontSize: '26px',
                  fontWeight: 700,
                  color: '#E5A030',
                  marginTop: '4px',
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '6px',
                }}
              >
                <span aria-hidden="true">★</span>
                <span data-stars-balance={starsBalance} data-testid="stars-balance">
                  {starsBalance}
                </span>
                <span style={{ fontSize: '13px', color: 'var(--tg-text-secondary)', fontWeight: 500 }}>
                  Stars
                </span>
              </div>
            </div>

            <div
              style={{
                padding: '14px 16px',
                borderRadius: '12px',
                backgroundColor: 'var(--tg-bg-elevated)',
                border: '1px solid rgba(41, 182, 246, 0.38)',
              }}
            >
              <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)', fontWeight: 500 }}>
                TON Space · Toncoin 余额
              </div>
              <div
                style={{
                  fontSize: '26px',
                  fontWeight: 700,
                  color: '#29B6F6',
                  marginTop: '4px',
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '6px',
                }}
              >
                <span aria-hidden="true">💎</span>
                <span data-ton-balance={tonBalance}>{tonBalance}</span>
                <span style={{ fontSize: '13px', color: 'var(--tg-text-secondary)', fontWeight: 500 }}>
                  TON
                </span>
              </div>
            </div>
          </div>

          {/* Quick Top-Up Buttons + Custom Amount */}
          <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
              ⚡ Top Up Stars · 快速充值星币
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {[100, 500, 1000].map((amt) => (
                <button
                  key={amt}
                  type="button"
                  className="tg-btn tg-btn--primary"
                  disabled={busyAction !== null}
                  onClick={() => void handleQuickTopUp(amt)}
                >
                  +{amt} ★ Top Up · 充值
                </button>
              ))}
            </div>

            <form onSubmit={(e) => void handleCustomTopUp(e)} style={{ display: 'flex', gap: '8px' }}>
              <input
                type="number"
                min={1}
                step={1}
                className="tg-input"
                aria-label="Custom Stars Top Up Amount 自定义充值数量"
                placeholder="Custom Stars amount"
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value)}
              />
              <button
                type="submit"
                className="tg-btn tg-btn--secondary"
                disabled={busyAction !== null}
                style={{ flexShrink: 0 }}
              >
                Top Up · 自定义充值
              </button>
            </form>
          </div>

          {/* Send Star Gift Form */}
          <form
            onSubmit={(e) => void handleSendGift(e)}
            className="tg-surface-card"
            style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
          >
            <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
              🎁 Send Star Gift · 赠送好友星币礼物
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <select
                className="tg-select"
                aria-label="Gift Recipient 选择赠送对象"
                value={recipientUserId}
                onChange={(e) => setRecipientUserId(Number(e.target.value))}
              >
                {recipientOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>

              <select
                className="tg-select"
                aria-label="Star Gift Preset 选择礼物档位"
                value={selectedGiftId}
                onChange={(e) => setSelectedGiftId(e.target.value)}
              >
                {GIFT_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                className="tg-input"
                aria-label="Gift Message 祝福语"
                placeholder="Attach a gift message · 附言祝福..."
                value={giftMessage}
                onChange={(e) => setGiftMessage(e.target.value)}
              />
              <button
                type="submit"
                className="tg-btn tg-btn--primary"
                disabled={busyAction !== null}
                style={{ flexShrink: 0 }}
              >
                Send Gift · 赠送礼物
              </button>
            </div>
          </form>

          {/* Transaction Ledger */}
          <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
              📜 Transaction Ledger · 交易流水账单 ({transactions.length})
            </div>

            {transactions.length === 0 ? (
              <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
                No transactions yet · 暂无流水记录
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '190px', overflowY: 'auto' }}>
                {transactions.map((tx) => {
                  const isPositive = tx.amount_stars >= 0 && tx.kind !== 'gift_sent' && tx.kind !== 'invoice_payment';
                  const signedAmount =
                    tx.kind === 'gift_sent' || tx.kind === 'invoice_payment'
                      ? -Math.abs(tx.amount_stars)
                      : Math.abs(tx.amount_stars);
                  return (
                    <div
                      key={tx.tx_id}
                      data-tx-kind={tx.kind}
                      style={{
                        padding: '8px 10px',
                        borderRadius: '8px',
                        backgroundColor: 'var(--tg-bg-elevated)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '10px',
                        fontSize: '12.5px',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600 }}>{tx.description || tx.kind}</div>
                        <div style={{ fontSize: '11px', color: 'var(--tg-text-secondary)' }}>
                          <code>{tx.kind}</code> · {new Date(tx.created_at_ms).toLocaleString()}
                        </div>
                      </div>
                      <div
                        style={{
                          fontWeight: 700,
                          color: isPositive ? 'var(--tg-success)' : '#E5A030',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {signedAmount > 0 ? `+${signedAmount}` : signedAmount} ★
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="tg-modal-footer">
          <button type="button" className="tg-btn tg-btn--secondary" onClick={handleClose}>
            Close · 关闭
          </button>
        </div>
      </div>
    </div>
  );
}
