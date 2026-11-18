import React, { useState } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { t } from '../../i18n';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface CreatePollModalProps {
  onClose: () => void;
}

const MAX_POLL_OPTIONS = 12;

export const CreatePollModal: React.FC<CreatePollModalProps> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const modalPayload = useUiStore((s) => s.modalPayload);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const activeTopicId = useChatStore((s) => s.activeTopicId);
  const createPoll = useChatStore((s) => s.createPoll);

  const isZh = language === 'zh-CN';
  const targetChatId = Number(modalPayload?.chatId ?? activeChatId ?? 0);

  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [allowsMultiple, setAllowsMultiple] = useState(false);
  const [isQuiz, setIsQuiz] = useState(false);
  const [correctIndex, setCorrectIndex] = useState(0);
  const [explanation, setExplanation] = useState('');
  const [errorAlert, setErrorAlert] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleOptionChange = (idx: number, val: string) => {
    setOptions((prev) => prev.map((item, i) => (i === idx ? val : item)));
    if (errorAlert) setErrorAlert(null);
  };

  const handleAddOption = () => {
    if (options.length >= MAX_POLL_OPTIONS) return;
    setOptions((prev) => [...prev, '']);
  };

  const handleRemoveOption = (idx: number) => {
    if (options.length <= 2) return;
    setOptions((prev) => prev.filter((_, i) => i !== idx));
    setCorrectIndex((prev) => {
      if (prev === idx) return 0;
      if (prev > idx) return prev - 1;
      return prev;
    });
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const cleanQuestion = question.trim();
    const indexedClean = options
      .map((raw, rawIdx) => ({ text: raw.trim(), rawIdx }))
      .filter((entry) => entry.text.length > 0);

    if (!cleanQuestion) {
      setErrorAlert(
        isZh ? '请输入投票问题（不能为空）' : 'Poll question cannot be empty.',
      );
      return;
    }

    if (indexedClean.length < 2) {
      setErrorAlert(
        isZh ? '请至少填写 2 个非空投票选项' : 'Please provide at least 2 non-empty poll options.',
      );
      return;
    }

    if (!targetChatId) {
      setErrorAlert(isZh ? '请先选择一个会话' : 'Please select an active chat first.');
      return;
    }

    const mappedCorrect = indexedClean.findIndex((e) => e.rawIdx === correctIndex);
    const resolvedCorrectId = mappedCorrect >= 0 ? mappedCorrect : 0;

    setIsSubmitting(true);
    setErrorAlert(null);
    try {
      await createPoll(targetChatId, {
        question: cleanQuestion,
        options: indexedClean.map((e) => e.text),
        isAnonymous,
        allowsMultipleAnswers: isQuiz ? false : allowsMultiple,
        isQuiz,
        correctOptionId: isQuiz ? resolvedCorrectId : undefined,
        explanation: isQuiz && explanation.trim() ? explanation.trim() : undefined,
        topicId: activeTopicId ?? undefined,
      });
      onClose();
    } catch (err) {
      setErrorAlert(err instanceof Error ? err.message : 'Failed to create poll');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="tg-modal-overlay"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        id={DOM_IDS.MODAL_CREATE_POLL}
        role="dialog"
        aria-modal="true"
        aria-label={t('poll.createTitle', language)}
        className="tg-modal-card"
      >
        <div className="tg-modal-header">
          <span>📊 {t('poll.createTitle', language)}</span>
          <button
            type="button"
            className="tg-icon-btn"
            aria-label={t('common.close', language)}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}>
          <div className="tg-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {errorAlert && (
              <div
                role="alert"
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  background: 'var(--tg-danger-soft)',
                  color: 'var(--tg-danger)',
                  fontSize: '13px',
                }}
              >
                {errorAlert}
              </div>
            )}

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <span>{t('poll.question', language)} *</span>
              <input
                type="text"
                className="tg-input"
                value={question}
                onChange={(e) => {
                  setQuestion(e.target.value);
                  if (errorAlert) setErrorAlert(null);
                }}
                placeholder={isZh ? '输入投票问题…' : 'Ask a question…'}
                aria-label={isZh ? '投票问题' : 'Poll Question'}
                autoFocus
              />
            </label>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--tg-text-secondary)' }}>
                {isZh
                  ? `投票选项 (${options.length}/${MAX_POLL_OPTIONS})`
                  : `Answer Options (${options.length}/${MAX_POLL_OPTIONS})`}
              </div>

              {options.map((opt, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {isQuiz && (
                    <input
                      type="radio"
                      name="quiz-correct-option"
                      data-testid={`quiz-correct-${idx}`}
                      aria-label={
                        isZh ? `设为正确选项 ${idx + 1}` : `Correct option ${idx + 1}`
                      }
                      checked={correctIndex === idx}
                      onChange={() => setCorrectIndex(idx)}
                      style={{ flexShrink: 0, cursor: 'pointer' }}
                    />
                  )}
                  <input
                    type="text"
                    className="tg-input"
                    value={opt}
                    onChange={(e) => handleOptionChange(idx, e.target.value)}
                    placeholder={`${t('poll.option', language)} ${idx + 1}`}
                    aria-label={`${t('poll.option', language)} ${idx + 1}`}
                  />
                  {options.length > 2 && (
                    <button
                      type="button"
                      className="tg-icon-btn"
                      aria-label={`Remove option ${idx + 1}`}
                      onClick={() => handleRemoveOption(idx)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}

              {options.length < MAX_POLL_OPTIONS && (
                <button
                  type="button"
                  className="tg-btn tg-btn--secondary"
                  style={{ alignSelf: 'flex-start', padding: '5px 12px', fontSize: '12.5px' }}
                  onClick={handleAddOption}
                >
                  + {t('poll.addOption', language)}
                </button>
              )}
            </div>

            {/* Poll Mode Toggles */}
            <div
              className="tg-surface-card"
              style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' }}
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={isAnonymous}
                  onChange={(e) => setIsAnonymous(e.target.checked)}
                />
                <span>{isZh ? '匿名投票 (Anonymous Voting)' : 'Anonymous Voting'}</span>
              </label>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '13px',
                  opacity: isQuiz ? 0.55 : 1,
                  cursor: isQuiz ? 'not-allowed' : 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={isQuiz ? false : allowsMultiple}
                  disabled={isQuiz}
                  onChange={(e) => setAllowsMultiple(e.target.checked)}
                />
                <span>{isZh ? '多选投票 (Multiple Answers)' : 'Multiple Answers'}</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={isQuiz}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setIsQuiz(checked);
                    if (checked) setAllowsMultiple(false);
                  }}
                />
                <span>{isZh ? '测验模式 (Quiz Mode)' : 'Quiz Mode'}</span>
              </label>
            </div>

            {isQuiz && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                <span>{t('poll.explanation', language)}</span>
                <input
                  type="text"
                  className="tg-input"
                  value={explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                  placeholder={
                    isZh ? '回答后显示的答案解析说明…' : 'Explanation shown after answering…'
                  }
                  aria-label={isZh ? '答案解析说明' : 'Quiz Explanation'}
                />
              </label>
            )}
          </div>

          <div className="tg-modal-footer">
            <button type="button" className="tg-btn tg-btn--secondary" onClick={onClose}>
              {t('common.cancel', language)}
            </button>
            <button
              type="submit"
              className="tg-btn tg-btn--primary"
              disabled={isSubmitting}
            >
              {t('common.create', language)}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreatePollModal;
