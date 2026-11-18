import {
  extractPlainTextFromContent,
  type ChatSummary,
  type MessageItem,
  type UserProfile,
} from '@gpui-telegram/protocol';

export interface ChatExportDocument {
  schema: 'gpui-telegram-chat-export/v1';
  exportedAtIso: string;
  exportedAtMs: number;
  chat: {
    id: number;
    title: string;
    kind: ChatSummary['kind'];
    username?: string;
    about?: string;
    memberCount?: number;
  };
  messageCount: number;
  messages: Array<{
    id: number;
    senderId: number;
    senderName: string;
    dateIso: string;
    timestampMs: number;
    text: string;
    contentType: MessageItem['content']['type'];
    isEdited: boolean;
    replyToMsgId?: number;
    reactions: Array<{ emoji: string; count: number }>;
  }>;
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sanitizeFileSlug(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'chat';
}

function resolveSenderDisplayName(
  msg: MessageItem,
  peers?: Record<number | string, UserProfile>,
): string {
  const peer = peers?.[msg.sender_id] ?? peers?.[String(msg.sender_id)];
  if (peer) {
    return `${peer.firstName} ${peer.lastName ?? ''}`.trim() || peer.username || String(msg.sender_id);
  }
  return msg.flags?.is_out ? 'Me' : `User ${msg.sender_id}`;
}

export function buildChatExportJson(
  chat: ChatSummary,
  messages: readonly MessageItem[],
  peers?: Record<number | string, UserProfile>,
): string {
  const nowMs = Date.now();
  const sorted = [...messages].sort((a, b) => a.id - b.id);
  const doc: ChatExportDocument = {
    schema: 'gpui-telegram-chat-export/v1',
    exportedAtIso: new Date(nowMs).toISOString(),
    exportedAtMs: nowMs,
    chat: {
      id: chat.chatId,
      title: chat.title,
      kind: chat.kind,
      username: chat.username,
      about: chat.about,
      memberCount: chat.memberCount,
    },
    messageCount: sorted.length,
    messages: sorted.map((m) => {
      const ts = m.date_ms ?? (Date.parse(m.date) || nowMs);
      const plain = m.text ?? extractPlainTextFromContent(m.content);
      return {
        id: m.id,
        senderId: m.sender_id,
        senderName: resolveSenderDisplayName(m, peers),
        dateIso: m.date || new Date(ts).toISOString(),
        timestampMs: ts,
        text: plain,
        contentType: m.content.type,
        isEdited: Boolean(m.isEdited || m.flags?.is_edited),
        replyToMsgId: m.reply_to?.reply_to_msg_id,
        reactions: (m.reactions ?? []).map((r) => ({ emoji: r.emoji, count: r.count })),
      };
    }),
  };

  return JSON.stringify(doc, null, 2);
}

export function buildChatExportHtml(
  chat: ChatSummary,
  messages: readonly MessageItem[],
  peers?: Record<number | string, UserProfile>,
): string {
  const nowIso = new Date().toISOString();
  const sorted = [...messages].sort((a, b) => a.id - b.id);

  const renderedMessages =
    sorted.length === 0
      ? `<div class="empty-state">No messages in this conversation yet.</div>`
      : sorted
          .map((m) => {
            const sender = escapeHtml(resolveSenderDisplayName(m, peers));
            const ts = m.date_ms ?? (Date.parse(m.date) || Date.now());
            const timeStr = escapeHtml(new Date(ts).toLocaleString());
            const plain = m.text ?? extractPlainTextFromContent(m.content);
            const bodyText = escapeHtml(plain || `[${m.content.type}]`).replaceAll('\n', '<br />');
            const dirCls = m.flags?.is_out ? 'bubble out' : 'bubble in';
            const reactionsHtml =
              m.reactions && m.reactions.length > 0
                ? `<div class="reactions">${m.reactions
                    .map((r) => `<span class="reaction">${escapeHtml(r.emoji)} ${r.count}</span>`)
                    .join('')}</div>`
                : '';

            return `<article class="${dirCls}" data-message-id="${m.id}">
        <div class="meta"><strong>${sender}</strong> · <time>${timeStr}</time> · #${m.id}</div>
        <div class="text">${bodyText}</div>
        ${reactionsHtml}
      </article>`;
          })
          .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Chat Export — ${escapeHtml(chat.title)}</title>
  <style>
    body {
      margin: 0;
      padding: 24px 16px;
      background: #0E1621;
      color: #F5F5F5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
      line-height: 1.5;
    }
    main { max-width: 760px; margin: 0 auto; }
    header {
      padding: 16px 20px;
      background: #17212B;
      border: 1px solid #242F3D;
      border-radius: 14px;
      margin-bottom: 16px;
    }
    h1 { margin: 0 0 6px; font-size: 20px; color: #F5F5F5; }
    .sub { font-size: 13px; color: #7F91A4; }
    .timeline { display: flex; flex-direction: column; gap: 10px; }
    .bubble {
      max-width: 82%;
      padding: 10px 14px;
      border-radius: 14px;
      border: 1px solid #242F3D;
      overflow-wrap: anywhere;
    }
    .bubble.in { align-self: flex-start; background: #182533; }
    .bubble.out { align-self: flex-end; background: #2B5278; }
    .meta { font-size: 12px; color: #8BB8E8; margin-bottom: 4px; }
    .reactions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    .reaction {
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(51, 144, 236, 0.2);
      font-size: 12px;
    }
    .empty-state {
      padding: 28px;
      text-align: center;
      background: #17212B;
      border: 1px solid #242F3D;
      border-radius: 12px;
      color: #7F91A4;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(chat.title)}</h1>
      <div class="sub">Chat ID: ${chat.chatId} · Kind: ${escapeHtml(chat.kind)} · Messages: ${sorted.length} · Exported: ${escapeHtml(nowIso)}</div>
    </header>
    <section class="timeline">
      ${renderedMessages}
    </section>
  </main>
</body>
</html>`;
}

export function triggerFileDownload(
  content: string | Blob,
  fileName: string,
  mimeType: string,
): { fileName: string; byteSize: number } {
  const blob =
    content instanceof Blob ? content : new Blob([content], { type: mimeType });

  if (typeof document !== 'undefined') {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    globalThis.setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore
      }
    }, 2_500);
  }

  return {
    fileName,
    byteSize: blob.size,
  };
}

export function exportAndDownloadChat(
  chat: ChatSummary,
  messages: readonly MessageItem[],
  format: 'json' | 'html',
  peers?: Record<number | string, UserProfile>,
  preRenderedServerPayload?: string,
): { content: string; fileName: string; mimeType: string } {
  const slug = sanitizeFileSlug(chat.title || String(chat.chatId));
  if (format === 'json') {
    let content = preRenderedServerPayload ?? '';
    if (!content) {
      content = buildChatExportJson(chat, messages, peers);
    } else {
      try {
        JSON.parse(content);
      } catch {
        content = buildChatExportJson(chat, messages, peers);
      }
    }
    const fileName = `telegram-export-${slug}.json`;
    const mimeType = 'application/json;charset=utf-8';
    triggerFileDownload(content, fileName, mimeType);
    return { content, fileName, mimeType };
  }

  const content =
    preRenderedServerPayload && preRenderedServerPayload.includes('<html')
      ? preRenderedServerPayload
      : buildChatExportHtml(chat, messages, peers);
  const fileName = `telegram-export-${slug}.html`;
  const mimeType = 'text/html;charset=utf-8';
  triggerFileDownload(content, fileName, mimeType);
  return { content, fileName, mimeType };
}
