import React, { useEffect, useMemo, useState } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { ApiRequestError, useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
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
  const redeemStars = useAiWorkspaceStore((s) => s.redeemStars);
  const sendStarGift = useAiWorkspaceStore((s) => s.sendStarGift);

  const contacts = useChatStore((s) => s.contacts);
  const activeChatId = useChatStore((s) => s.activeChatId);

  const [redeemMode, setRedeemMode] = useState<'redeem_code' | 'order_id'>('redeem_code');
  const [redeemValue, setRedeemValue] = useState('');
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [recipientUserId, setRecipientUserId] = useState<number>(0);
  const [selectedGiftId, setSelectedGiftId] = useState(GIFT_PRESETS[0].id);
  const [giftMessage, setGiftMessage] = useState('');
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
        const fullName =
          [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || `User #${uid}`;
        list.push({
          id: uid,
          label: `${fullName}${u.username ? ` (@${u.username})` : ''}`,
        });
      }
    }
    return list;
  }, [contacts]);

  useEffect(() => {
    if (!recipientUserId && recipientOptions.length > 0) {
      setRecipientUserId(recipientOptions[0].id);
    }
  }, [recipientUserId, recipientOptions]);

  if (!visible) return null;

  const handleClose = () => {
    if (onClose) onClose();
    else closeModal();
  };

  const starsBalance = Number(wallet?.stars_balance ?? wallet?.balance ?? 0);
  const tonDisplay =
    typeof wallet?.ton_balance === 'number'
      ? String(wallet.ton_balance)
      : typeof wallet?.ton_balance === 'string' && wallet.ton_balance.trim()
        ? wallet.ton_balance
        : String(Number(wallet?.ton_nano ?? 0) / 1e9);

  const selectedPreset =
    GIFT_PRESETS.find((g) => g.id === selectedGiftId) ?? GIFT_PRESETS[0];
  const insufficientForGift = starsBalance < selectedPreset.stars;

  const handleRedeemSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setRedeemError(null);
    const trimmed = redeemValue.trim();
    if (!trimmed) {
      setRedeemError(
        redeemMode === 'redeem_code'
          ? 'Please enter an admin-issued Stars redeem code · 请输入兑换码'
          : 'Please enter a verified paid order ID · 请输入已支付订单号',
      );
      return;
    }
    setBusyAction('redeem');
    try {
      await redeemStars(
        redeemMode === 'redeem_code' ? { redeem_code: trimmed } : { order_id: trimmed },
      );
      setRedeemValue('');
      pushToast('Stars credited via verified payment/redeem · 星币已核销入账', 'success');
    } catch (err) {
      const msg =
        err instanceof ApiRequestError
          ? `${err.status} ${err.errorCode}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setRedeemError(msg);
      pushToast(msg, 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSendGift = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!recipientUserId) {
      pushToast('Select a recipient first · 请先选择接收人', 'warning');
      return;
    }
    if (insufficientForGift) {
      pushToast('Insufficient Stars balance · 星币余额不足', 'warning');
      return;
    }
    setBusyAction('gift');
    try {
      await sendStarGift({
        toUserId: recipientUserId,
        chatId: activeChatId ?? undefined,
        amountStars: selectedPreset.stars,
        giftId: selectedPreset.id,
        message: giftMessage.trim() || undefined,
      });
      setGiftMessage('');
      pushToast(`Sent ${selectedPreset.label} successfully`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      className="tg-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Stars & TON Wallet"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        id={DOM_IDS.WALLET_STARS_MODAL}
        className="tg-modal-card"
        style={{ width: 'min(560px, 94vw)', maxHeight: '88vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div className="tg-ai-row tg-ai-row--between">
          <h3 className="tg-ai-workspace__title">⭐ Stars & TON Wallet · 星币与钱包</h3>
          <button type="button" className="tg-btn tg-btn--ghost" onClick={handleClose}>
            ✕ Close
          </button>
        </div>

        {/* Truthful Server Balances (Starts at 0 Stars / 0 TON) */}
        <div className="tg-wallet-balance-hero">
          <div className="tg-wallet-metric-card" data-stars-balance={String(starsBalance)}>
            <span className="tg-ai-workspace__subtitle">Telegram Stars · 星币余额</span>
            <span className="tg-wallet-metric-value">★ {starsBalance}</span>
          </div>
          <div className="tg-wallet-metric-card" data-ton-balance={tonDisplay}>
            <span className="tg-ai-workspace__subtitle">TON Balance · TON 余额</span>
            <span className="tg-wallet-metric-value">{tonDisplay} TON</span>
          </div>
        </div>

        {/* Verified Payment / Redeem Credit Form (Zero Unverified Self-Minting) */}
        <section className="tg-ai-card tg-ai-card--elevated">
          <div className="tg-ai-card__header">
            <h4 className="tg-ai-card__title">🎟️ Verified Credit · 核销充值码或已支付订单</h4>
            <span className="tg-ai-badge tg-ai-badge--info">Server Payment-Gated (402)</span>
          </div>

          <div className="tg-ai-row">
            <button
              type="button"
              className={`tg-btn ${redeemMode === 'redeem_code' ? 'tg-btn--primary' : 'tg-btn--ghost'}`}
              onClick={() => {
                setRedeemMode('redeem_code');
                setRedeemError(null);
              }}
            >
              Redeem Code · 兑换码
            </button>
            <button
              type="button"
              className={`tg-btn ${redeemMode === 'order_id' ? 'tg-btn--primary' : 'tg-btn--ghost'}`}
              onClick={() => {
                setRedeemMode('order_id');
                setRedeemError(null);
              }}
            >
              Paid Order ID · 支付订单号
            </button>
          </div>

          <form onSubmit={(e) => void handleRedeemSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className="tg-ai-field">
              <span>
                {redeemMode === 'redeem_code'
                  ? 'Redeem Code · 管理员签发兑换码'
                  : 'Verified Paid Order ID · 已支付订单号'}
              </span>
              <input
                type="text"
                value={redeemValue}
                onChange={(e) => setRedeemValue(e.target.value)}
                placeholder={
                  redeemMode === 'redeem_code' ? 'STARS-XXXX-XXXX' : 'order_paid_...'
                }
              />
            </label>

            {redeemError && (
              <div role="alert" className="tg-secret-leak-alert">
                {redeemError}
              </div>
            )}

            <button
              type="submit"
              className="tg-btn tg-btn--primary"
              disabled={busyAction !== null}
            >
              {busyAction === 'redeem'
                ? 'Verifying…'
                : 'Redeem / Verify Order · 核销充值码或订单'}
            </button>
          </form>
        </section>

        {/* Send Star Gift */}
        <section className="tg-ai-card tg-ai-card--elevated">
          <h4 className="tg-ai-card__title">🎁 Send Star Gift · 赠送星币礼物</h4>
          <form onSubmit={(e) => void handleSendGift(e)} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className="tg-ai-field">
              <span>Recipient · 接收人</span>
              <select
                value={recipientUserId}
                onChange={(e) => setRecipientUserId(Number(e.target.value))}
              >
                {recipientOptions.length === 0 ? (
                  <option value={0}>No contacts available · 暂无联系人</option>
                ) : (
                  recipientOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))
                )}
              </select>
            </label>

            <label className="tg-ai-field">
              <span>Gift Preset · 礼物款式</span>
              <select
                value={selectedGiftId}
                onChange={(e) => setSelectedGiftId(e.target.value)}
              >
                {GIFT_PRESETS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="tg-ai-field">
              <span>Note (Optional) · 附言</span>
              <input
                type="text"
                value={giftMessage}
                onChange={(e) => setGiftMessage(e.target.value)}
                placeholder="Thank you!"
              />
            </label>

            {insufficientForGift && (
              <div className="tg-ai-workspace__subtitle" style={{ color: 'var(--tg-warning)' }}>
                Insufficient Stars balance ({starsBalance} / {selectedPreset.stars} ★ required) · 星币余额不足，请先核销有效充值码或订单。
              </div>
            )}

            <button
              type="submit"
              className="tg-btn tg-btn--secondary"
              disabled={busyAction !== null || insufficientForGift || !recipientUserId}
            >
              {busyAction === 'gift' ? 'Sending…' : `Send Gift (${selectedPreset.stars} ★)`}
            </button>
          </form>
        </section>

        {/* Transaction History */}
        <section className="tg-ai-card tg-ai-card--elevated">
          <h4 className="tg-ai-card__title">
            📜 Ledger Transactions · 账单记录 ({wallet?.transactions?.length ?? 0})
          </h4>
          {(wallet?.transactions ?? []).length === 0 ? (
            <div className="tg-ai-empty">No wallet transactions yet · 暂无交易记录</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(wallet?.transactions ?? []).map((tx) => (
                <div
                  key={tx.tx_id}
                  className="tg-ai-row tg-ai-row--between"
                  style={{ fontSize: 12, padding: '6px 0', borderBottom: '1px solid var(--tg-border-subtle)' }}
                >
                  <span>{tx.description}</span>
                  <strong>
                    {tx.amount_stars >= 0 ? `+${tx.amount_stars}` : tx.amount_stars} ★
                  </strong>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
