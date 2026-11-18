import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { NON_PURPLE_ACCENT_SWATCHES } from '../../store/useSettingsStore';
import { useChatStore } from '../../store/useChatStore';
import { useUiStore, type MediaEditorState } from '../../store/useUiStore';

type CropPreset = MediaEditorState['cropRatio'];

function computeCenteredCropRect(
  srcW: number,
  srcH: number,
  cropRatio: CropPreset,
): { sx: number; sy: number; sw: number; sh: number } {
  if (cropRatio === 'free' || srcW <= 0 || srcH <= 0) {
    return { sx: 0, sy: 0, sw: Math.max(1, srcW), sh: Math.max(1, srcH) };
  }
  const targetAspect =
    cropRatio === '1:1' ? 1 : cropRatio === '16:9' ? 16 / 9 : 4 / 3;
  const currentAspect = srcW / srcH;

  if (currentAspect > targetAspect) {
    const sw = Math.max(1, Math.round(srcH * targetAspect));
    const sx = Math.floor((srcW - sw) / 2);
    return { sx, sy: 0, sw, sh: srcH };
  }
  const sh = Math.max(1, Math.round(srcW / targetAspect));
  const sy = Math.floor((srcH - sh) / 2);
  return { sx: 0, sy, sw: srcW, sh };
}

export const MediaEditorModal: React.FC = () => {
  const mediaEditorState = useUiStore((s) => s.mediaEditorState);
  const updateMediaEditor = useUiStore((s) => s.updateMediaEditor);
  const closeMediaEditor = useUiStore((s) => s.closeMediaEditor);
  const pushToast = useUiStore((s) => s.pushToast);
  const sendMediaFiles = useChatStore((s) => s.sendMediaFiles);
  const activeTopicId = useChatStore((s) => s.activeTopicId);
  const replyTargetByChat = useChatStore((s) => s.replyTargetByChat);
  const setReplyTarget = useChatStore((s) => s.setReplyTarget);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const activeStrokeRef = useRef<Array<{ x: number; y: number }> | null>(null);

  const [rotationDeg, setRotationDeg] = useState<0 | 90 | 180 | 270>(0);
  const [brushColor, setBrushColor] = useState<string>('#E15B64');
  const [brushEnabled, setBrushEnabled] = useState<boolean>(true);
  const [decodeFailed, setDecodeFailed] = useState<boolean>(false);
  const [imageReadyTick, setImageReadyTick] = useState<number>(0);
  const [isSending, setIsSending] = useState<boolean>(false);

  // Reset local editor state when a new file opens
  useEffect(() => {
    if (!mediaEditorState?.isOpen) {
      imageRef.current = null;
      setRotationDeg(0);
      setDecodeFailed(false);
      setIsSending(false);
      return;
    }

    let cancelled = false;
    setRotationDeg(0);
    setDecodeFailed(false);
    setBrushEnabled(true);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
        setDecodeFailed(true);
        return;
      }
      imageRef.current = img;
      setImageReadyTick((n) => n + 1);
    };
    img.onerror = () => {
      if (cancelled) return;
      imageRef.current = null;
      setDecodeFailed(true);
    };
    img.src = mediaEditorState.previewUrl;

    return () => {
      cancelled = true;
    };
  }, [mediaEditorState?.isOpen, mediaEditorState?.previewUrl]);

  // Redraw canvas whenever image, rotation, crop, or brush annotations change
  const redrawCanvas = useCallback(
    (inProgressPoints?: Array<{ x: number; y: number }>) => {
      const canvas = canvasRef.current;
      const img = imageRef.current;
      if (!canvas || !img || !mediaEditorState) return;

      const natW = img.naturalWidth || 320;
      const natH = img.naturalHeight || 240;

      // Build rotated intermediate offscreen canvas first so crop & brush apply cleanly
      const quarterTurn = rotationDeg === 90 || rotationDeg === 270;
      const rotW = quarterTurn ? natH : natW;
      const rotH = quarterTurn ? natW : natH;

      const rotCanvas = document.createElement('canvas');
      rotCanvas.width = rotW;
      rotCanvas.height = rotH;
      const rotCtx = rotCanvas.getContext('2d');
      if (rotCtx) {
        rotCtx.save();
        rotCtx.translate(rotW / 2, rotH / 2);
        rotCtx.rotate((rotationDeg * Math.PI) / 180);
        rotCtx.drawImage(img, -natW / 2, -natH / 2, natW, natH);
        rotCtx.restore();
      }

      const crop = computeCenteredCropRect(rotW, rotH, mediaEditorState.cropRatio);
      if (canvas.width !== crop.sw || canvas.height !== crop.sh) {
        canvas.width = crop.sw;
        canvas.height = crop.sh;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(
        rotCanvas,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        0,
        0,
        crop.sw,
        crop.sh,
      );

      const allStrokes = [
        ...mediaEditorState.annotations,
        ...(inProgressPoints && inProgressPoints.length > 0
          ? [{ points: inProgressPoints, color: brushColor }]
          : []),
      ];

      for (const stroke of allStrokes) {
        if (stroke.points.length === 0) continue;
        ctx.save();
        ctx.strokeStyle = stroke.color;
        ctx.fillStyle = stroke.color;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(3, Math.round(Math.min(canvas.width, canvas.height) * 0.02));

        if (stroke.points.length === 1) {
          const pt = stroke.points[0]!;
          ctx.beginPath();
          ctx.arc(pt.x * canvas.width, pt.y * canvas.height, ctx.lineWidth / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          stroke.points.forEach((pt, idx) => {
            const px = pt.x * canvas.width;
            const py = pt.y * canvas.height;
            if (idx === 0) {
              ctx.moveTo(px, py);
            } else {
              ctx.lineTo(px, py);
            }
          });
          ctx.stroke();
        }
        ctx.restore();
      }
    },
    [brushColor, mediaEditorState, rotationDeg],
  );

  useEffect(() => {
    if (!mediaEditorState?.isOpen || decodeFailed) return;
    redrawCanvas();
  }, [
    decodeFailed,
    imageReadyTick,
    mediaEditorState?.annotations,
    mediaEditorState?.cropRatio,
    mediaEditorState?.isOpen,
    redrawCanvas,
    rotationDeg,
  ]);

  const toNormalizedPoint = (
    e: React.PointerEvent<HTMLCanvasElement>,
  ): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
    const y = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!brushEnabled || !mediaEditorState) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointer events in headless tests may not have an active pointerId
    }
    const pt = toNormalizedPoint(e);
    activeStrokeRef.current = [pt];
    redrawCanvas(activeStrokeRef.current);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!brushEnabled || !activeStrokeRef.current) return;
    e.preventDefault();
    const pt = toNormalizedPoint(e);
    activeStrokeRef.current.push(pt);
    redrawCanvas(activeStrokeRef.current);
  };

  const finalizeStroke = () => {
    if (!activeStrokeRef.current || !mediaEditorState) return;
    const finished = activeStrokeRef.current;
    activeStrokeRef.current = null;
    if (finished.length > 0) {
      updateMediaEditor({
        annotations: [
          ...mediaEditorState.annotations,
          { points: finished, color: brushColor },
        ],
      });
    }
  };

  const handleSend = async () => {
    if (!mediaEditorState || isSending) return;
    setIsSending(true);

    try {
      const chatId = mediaEditorState.chatId;
      const replyTarget = replyTargetByChat[chatId];
      const hasEdits =
        rotationDeg !== 0 ||
        mediaEditorState.cropRatio !== 'free' ||
        mediaEditorState.annotations.length > 0;

      let fileToSend: File | Blob = mediaEditorState.file;
      if (decodeFailed) {
        const safeName = mediaEditorState.fileName || 'attachment.bin';
        fileToSend = new File([mediaEditorState.file], safeName, {
          type: 'application/octet-stream',
        });
      } else if (hasEdits && canvasRef.current) {
        const canvas = canvasRef.current;
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), 'image/png'),
        );
        if (blob) {
          const baseName = (mediaEditorState.fileName || 'edited-image.png').replace(
            /\.[^.]+$/,
            '',
          );
          fileToSend = new File([blob], `${baseName}.png`, {
            type: 'image/png',
          });
        }
      }

      await sendMediaFiles(chatId, [fileToSend], {
        caption: mediaEditorState.caption.trim() || undefined,
        hasSpoiler: mediaEditorState.hasSpoiler,
        topicId: activeTopicId ?? undefined,
        replyToMsgId: replyTarget?.messageId,
      });

      if (replyTarget) {
        setReplyTarget(chatId, null);
      }
      closeMediaEditor();
    } catch (err) {
      pushToast(
        err instanceof Error ? err.message : 'Failed to send media',
        'error',
      );
      setIsSending(false);
    }
  };

  useEffect(() => {
    if (!mediaEditorState?.isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        closeMediaEditor();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeMediaEditor, mediaEditorState?.isOpen]);

  if (!mediaEditorState || !mediaEditorState.isOpen) {
    return null;
  }

  const cropOptions: Array<{ id: CropPreset; label: string }> = [
    { id: 'free', label: 'Original' },
    { id: '1:1', label: 'Crop 1:1' },
    { id: '16:9', label: 'Crop 16:9' },
    { id: '4:3', label: 'Crop 4:3' },
  ];

  return (
    <div
      className="tg-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          closeMediaEditor();
        }
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1150,
        backgroundColor: 'rgba(10, 15, 22, 0.84)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        id={DOM_IDS.MODAL_MEDIA_EDITOR}
        data-testid="modal-media-editor"
        role="dialog"
        aria-modal="true"
        aria-label="Edit Media"
        className="tg-modal-card"
        style={{
          width: 'min(640px, 95vw)',
          maxHeight: '90dvh',
          backgroundColor: 'var(--tg-bg-surface, #17212B)',
          color: 'var(--tg-text-primary, #F5F5F5)',
          border: '1px solid var(--tg-border, #242F3D)',
          borderRadius: '14px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 48px rgba(0, 0, 0, 0.5)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--tg-border, #242F3D)',
          }}
        >
          <strong style={{ fontSize: '15px' }}>Send Photo · Media Editor</strong>
          <button
            type="button"
            aria-label="Close"
            onClick={() => closeMediaEditor()}
            style={editorGhostBtnStyle(false)}
          >
            ✕
          </button>
        </div>

        {/* Canvas Stage */}
        <div
          style={{
            backgroundColor: '#0E1621',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '220px',
            maxHeight: '46dvh',
            padding: '12px',
            overflow: 'hidden',
          }}
        >
          {decodeFailed ? (
            <div
              data-testid="media-editor-fallback"
              style={{
                padding: '20px',
                textAlign: 'center',
                color: 'var(--tg-text-secondary, #8FA2B7)',
                fontSize: '13px',
              }}
            >
              <div style={{ fontSize: '24px', marginBottom: '6px' }}>📄</div>
              <div>
                Image preview could not be decoded ({mediaEditorState.fileName}).
              </div>
              <div>Click Send to upload safely as a document file.</div>
            </div>
          ) : (
            <canvas
              ref={canvasRef}
              data-testid="media-editor-canvas"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finalizeStroke}
              onPointerCancel={finalizeStroke}
              style={{
                maxWidth: '100%',
                maxHeight: '42dvh',
                objectFit: 'contain',
                borderRadius: '6px',
                cursor: brushEnabled ? 'crosshair' : 'default',
                touchAction: 'none',
                filter: mediaEditorState.hasSpoiler ? 'blur(12px)' : 'none',
              }}
            />
          )}
        </div>

        {/* Editing Controls */}
        {!decodeFailed && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '6px',
              padding: '10px 16px',
              borderTop: '1px solid var(--tg-border, #242F3D)',
              borderBottom: '1px solid var(--tg-border, #242F3D)',
              backgroundColor: 'var(--tg-bg-elevated, #1E2C3A)',
            }}
          >
            <button
              type="button"
              data-testid="media-editor-rotate"
              aria-label="Rotate 90°"
              onClick={() =>
                setRotationDeg(
                  (prev) => (((prev + 90) % 360) as 0 | 90 | 180 | 270),
                )
              }
              style={editorGhostBtnStyle(rotationDeg !== 0)}
            >
              ↻ Rotate
            </button>

            {cropOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                data-testid={`media-editor-crop-${opt.id}`}
                aria-pressed={mediaEditorState.cropRatio === opt.id}
                onClick={() => updateMediaEditor({ cropRatio: opt.id })}
                style={editorGhostBtnStyle(mediaEditorState.cropRatio === opt.id)}
              >
                {opt.label}
              </button>
            ))}

            <button
              type="button"
              data-testid="media-editor-draw"
              aria-pressed={brushEnabled}
              onClick={() => setBrushEnabled((v) => !v)}
              style={editorGhostBtnStyle(brushEnabled)}
            >
              ✎ Draw
            </button>

            {NON_PURPLE_ACCENT_SWATCHES.slice(0, 5).map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={`Brush color ${hex}`}
                onClick={() => {
                  setBrushColor(hex);
                  setBrushEnabled(true);
                }}
                style={{
                  width: '20px',
                  height: '20px',
                  borderRadius: '50%',
                  backgroundColor: hex,
                  border:
                    brushColor === hex
                      ? '2px solid #FFFFFF'
                      : '1px solid rgba(255,255,255,0.25)',
                  cursor: 'pointer',
                  padding: 0,
                }}
              />
            ))}

            {mediaEditorState.annotations.length > 0 && (
              <button
                type="button"
                data-testid="media-editor-undo"
                onClick={() =>
                  updateMediaEditor({
                    annotations: mediaEditorState.annotations.slice(0, -1),
                  })
                }
                style={editorGhostBtnStyle(false)}
              >
                ↶ Undo
              </button>
            )}
          </div>
        )}

        {/* Spoiler + Caption + Submit */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            padding: '12px 16px 14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button
              type="button"
              role="checkbox"
              aria-checked={mediaEditorState.hasSpoiler}
              aria-label="Hide with Spoiler"
              data-testid="media-editor-spoiler"
              onClick={() =>
                updateMediaEditor({ hasSpoiler: !mediaEditorState.hasSpoiler })
              }
              style={{
                ...editorGhostBtnStyle(mediaEditorState.hasSpoiler),
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span>{mediaEditorState.hasSpoiler ? '☑' : '☐'}</span>
              <span>Spoiler · 剧透遮罩</span>
            </button>
            <span style={{ fontSize: '12px', color: 'var(--tg-text-secondary, #7F91A4)' }}>
              {mediaEditorState.fileName}
            </span>
          </div>

          <input
            type="text"
            data-testid="media-editor-caption"
            aria-label="Caption"
            placeholder="Add a caption…"
            value={mediaEditorState.caption}
            onChange={(e) => updateMediaEditor({ caption: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleSend();
              }
            }}
            style={{
              width: '100%',
              padding: '9px 12px',
              borderRadius: '8px',
              border: '1px solid var(--tg-border, #242F3D)',
              backgroundColor: 'var(--tg-bg-app, #0E1621)',
              color: 'var(--tg-text-primary, #F5F5F5)',
              fontSize: '14px',
              boxSizing: 'border-box',
            }}
          />

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button
              type="button"
              data-testid="media-editor-cancel"
              onClick={() => closeMediaEditor()}
              disabled={isSending}
              style={editorGhostBtnStyle(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="media-editor-send"
              onClick={() => void handleSend()}
              disabled={isSending}
              style={{
                padding: '8px 18px',
                borderRadius: '8px',
                border: 'none',
                backgroundColor: 'var(--tg-accent, #3390EC)',
                color: '#FFFFFF',
                fontSize: '14px',
                fontWeight: 600,
                cursor: isSending ? 'wait' : 'pointer',
              }}
            >
              {isSending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function editorGhostBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '5px 10px',
    borderRadius: '7px',
    border: active
      ? '1px solid var(--tg-accent, #3390EC)'
      : '1px solid var(--tg-border, #2B394A)',
    backgroundColor: active
      ? 'rgba(51, 144, 236, 0.18)'
      : 'rgba(255, 255, 255, 0.04)',
    color: active ? '#6AB8FF' : 'var(--tg-text-primary, #F5F5F5)',
    fontSize: '12px',
    fontWeight: 500,
    cursor: 'pointer',
  };
}
