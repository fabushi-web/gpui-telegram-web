import { describe, expect, it } from 'vitest';
import {
  DATA_ATTRS,
  DATA_TEST_IDS,
  DOM_IDS,
  E2EE_SAFETY_EMOJIS,
  FABUSHI_PROTOCOL_VERSION,
  ImeSafetyFsm,
  TELEGRAM_WAVEFORM_BARS,
  TELEGRAM_WAVEFORM_BYTES,
  clampGenerativeProgress,
  computeSafetyNumberEmojis,
  decodeWaveform5Bit,
  decodeWaveformBase64,
  decryptSecretMessage,
  deriveSharedAesGcmKey,
  detectPtsGap,
  domSelector,
  encodeQrMatrix,
  encodeWaveform5Bit,
  encodeWaveformBase64,
  encryptSecretMessage,
  extractEntityUtf16,
  extractWaveformBarsFromPcm,
  extractWaveformFromFloat32Pcm,
  fromWireMessageEntity,
  generateE2eeIdentity,
  isPtsContinuous,
  isPtsStaleOrDuplicate,
  isSafeEntityUrl,
  mapChatFolderDtoToDomain,
  mapForumTopicDtoToDomain,
  mapStoryDtoToDomain,
  parseMarkdownEntities,
  renderEntitiesToSafeHtml,
  renderQrCodeSvg,
  serializeEntitiesToMarkdown,
  signPreKeyPublic,
  verifyPreKeySignature,
  type MessageEntityType,
  type StoryDto,
  type SyncGetDifferenceResponse,
} from '@gpui-telegram/protocol';

describe('@gpui-telegram/protocol — Canonical DOM IDs & Domain Mappers', () => {
  it('exports all 150 unique canonical DOM IDs without leading # and domain DTO mappers', () => {
    expect(FABUSHI_PROTOCOL_VERSION).toBe('1.6.11');

    const entries = Object.entries(DOM_IDS);
    expect(entries.length).toBe(150);

    const uniqueValues = new Set(entries.map(([, v]) => v));
    expect(uniqueValues.size).toBe(150);

    for (const [, val] of entries) {
      expect(val.startsWith('#')).toBe(false);
      expect(val).toMatch(/^[a-z0-9-]+$/);
    }

    expect(domSelector(DOM_IDS.AUTH_SCREEN)).toBe('#auth-screen');
    expect(domSelector(DOM_IDS.NAV_DEST_BROWSER)).toBe('#nav-dest-browser');
    expect(domSelector(DOM_IDS.BROWSER_CONTROL_WORKSPACE)).toBe('#browser-control-workspace');
    expect(domSelector(DOM_IDS.SIDEBAR_PINNED_CHATS_GRID)).toBe('#sidebar-pinned-chats-grid');
    expect(domSelector(DOM_IDS.APPLE_COMPOSE_STAGE)).toBe('#apple-compose-stage');
    expect(domSelector(DOM_IDS.BOT_PRESTART_BAR)).toBe('#bot-prestart-bar');
    expect(domSelector(DOM_IDS.CMP_INPUT_WRAP)).toBe('#cmp-input-wrap');
    expect(domSelector(DOM_IDS.STAGE_TOAST_PILL)).toBe('#stage-toast-pill');
    expect(domSelector(DOM_IDS.WINDOW_TOAST_BANNER)).toBe('#window-toast-banner');
    expect(domSelector(DOM_IDS.MINIAPP_PIP_OVERLAY)).toBe('#miniapp-pip-overlay');
    expect(domSelector(DOM_IDS.BROWSER_WORKSPACE)).toBe('#browser-workspace');
    expect(domSelector(DOM_IDS.BROWSER_INSPECTOR_TABS)).toBe('#browser-inspector-tabs');
    expect(domSelector(DOM_IDS.AUTOMATION_APP_STORE_PANEL)).toBe('#automation-app-store-panel');
    expect(domSelector(DOM_IDS.OAUTH_MCP_GRANTS_PANEL)).toBe('#oauth-mcp-grants-panel');
    expect(domSelector(DOM_IDS.REMOTE_ASSIST_PANEL)).toBe('#remote-assist-panel');
    expect(domSelector(DOM_IDS.VAULT_SETTINGS_PANEL)).toBe('#vault-settings-panel');
    expect(DATA_TEST_IDS.CHAT_ROW).toBe('chat-row');
    expect(DATA_TEST_IDS.MESSAGE_BUBBLE).toBe('message-bubble');
    expect(DATA_ATTRS.CHAT_ID).toBe('data-chat-id');
    expect(DATA_ATTRS.HERMES_TAB).toBe('data-hermes-tab');

    const kindCheck: MessageEntityType = 'custom_emoji';
    expect(kindCheck).toBe('custom_emoji');

    const topicDomain = mapForumTopicDtoToDomain({
      chat_id: 103,
      topic_id: 2,
      title: 'Engineering',
      icon_color: 0x6fb9f0,
      icon_emoji: '⚙️',
      creator_id: 1001,
      is_pinned: true,
      is_closed: false,
      is_hidden: false,
      last_message_id: 10,
      unread_count: 1,
      created_at_ms: 1700000000000,
    });
    expect(topicDomain.topicId).toBe(2);
    expect(topicDomain.isPinned).toBe(true);

    const folderDomain = mapChatFolderDtoToDomain({
      id: 3,
      title: 'Work',
      emoticon: '💼',
      include_chats: [101, 102],
      exclude_chats: [],
      pinned_chats: [101],
      include_contacts: false,
      include_non_contacts: false,
      include_groups: true,
      include_channels: false,
      include_bots: false,
      exclude_muted: false,
      exclude_read: false,
      exclude_archived: true,
      sort_order: 1,
    });
    expect(folderDomain.includedChatIds).toEqual([101, 102]);

    const storyWire: StoryDto = {
      story_id: 'story_1',
      user_id: 1001,
      first_name: 'Alice',
      media_type: 'gradient',
      privacy: 'everyone',
      views_count: 7,
      is_viewed: true,
      created_at_ms: 1000,
      expires_at_ms: 2000,
    };
    const storyDomain = mapStoryDtoToDomain(storyWire);
    expect(storyDomain.storyId).toBe('story_1');
    expect(storyDomain.viewsCount).toBe(7);

    // SyncGetDifferenceResponse allows omitting status
    const diffCompat: SyncGetDifferenceResponse = {
      chat_id: 101,
      new_messages: [],
      other_updates: [],
      pts: 5,
      current_pts: 5,
      updates: [],
      has_more: false,
      snapshot_required: false,
    };
    expect(diffCompat.pts).toBe(5);
  });
});

describe('@gpui-telegram/protocol — UTF-16 MessageEntity & Markdown Parser/Serializer', () => {
  it('computes exact UTF-16 code-unit offsets across surrogate-pair emojis and CJK characters', () => {
    const md = 'Hi 🎉 中文 **bold 🚀** and *italic* plus __under__ ~~strike~~ ||spoiler|| `x_1`';
    const parsed = parseMarkdownEntities(md);

    expect(parsed.text).toBe('Hi 🎉 中文 bold 🚀 and italic plus under strike spoiler x_1');

    const byType = new Map(parsed.entities.map((e) => [e.type, e]));
    expect(extractEntityUtf16(parsed.text, byType.get('bold')!)).toBe('bold 🚀');
    expect(extractEntityUtf16(parsed.text, byType.get('italic')!)).toBe('italic');
    expect(extractEntityUtf16(parsed.text, byType.get('underline')!)).toBe('under');
    expect(extractEntityUtf16(parsed.text, byType.get('strikethrough')!)).toBe('strike');
    expect(extractEntityUtf16(parsed.text, byType.get('spoiler')!)).toBe('spoiler');
    expect(extractEntityUtf16(parsed.text, byType.get('code')!)).toBe('x_1');

    // Verify ZWJ family emoji (11 UTF-16 code units)
    const zwj = parseMarkdownEntities('👨‍👩‍👧‍👦 **family**');
    expect('👨‍👩‍👧‍👦 '.length).toBe(12);
    expect(zwj.entities[0]?.offset).toBe(12);
    expect(zwj.entities[0]?.length).toBe(6);
    expect(extractEntityUtf16(zwj.text, zwj.entities[0]!)).toBe('family');
  });

  it('round-trips co-extensive nested entities in strict LIFO order, preserves multi-spoilers in blockquotes, and clamps mid-surrogate offsets', () => {
    const cases = [
      '**__粗体加下划线🚀__**',
      '**||粗体剧透||**',
      '[**粗体链接🎉**](https://gpui.dev)',
      '**_粗斜体_**',
      '***三体粗斜***',
      '> ||剧透A|| 中间文本 ||剧透B||',
      '>> 可折叠引用 **重点**',
    ];

    for (const input of cases) {
      const p1 = parseMarkdownEntities(input);
      const serialized = serializeEntitiesToMarkdown(p1.text, p1.entities);
      const p2 = parseMarkdownEntities(serialized);
      expect(p2.text).toBe(p1.text);
      expect(p2.entities.map((e) => ({ type: e.type, offset: e.offset, length: e.length, collapsed: e.collapsed }))).toEqual(
        p1.entities.map((e) => ({ type: e.type, offset: e.offset, length: e.length, collapsed: e.collapsed })),
      );
    }

    // Verify > ||剧透A|| 中间文本 ||剧透B|| specifically marks ONLY 剧透A and 剧透B as spoilers!
    const multiSpoilerQuote = parseMarkdownEntities('> ||剧透A|| 中间文本 ||剧透B||');
    const spoilers = multiSpoilerQuote.entities.filter((e) => e.type === 'spoiler');
    expect(spoilers.map((s) => extractEntityUtf16(multiSpoilerQuote.text, s))).toEqual(['剧透A', '剧透B']);

    // Mid-surrogate offset clamping must NEVER split surrogate pairs into invalid UTF-16
    const emojiText = '🎉火';
    const clampedMd = serializeEntitiesToMarkdown(emojiText, [
      { offset: 0, length: 1, type: 'bold' }, // length 1 lands mid-surrogate on 🎉 -> clamped to 0!
      { offset: 1, length: 2, type: 'italic' }, // offset 1 clamped to 0, end 3 -> '*🎉火*'
    ]);
    // Verify zero lone surrogates exist in output
    for (let i = 0; i < clampedMd.length; i++) {
      const code = clampedMd.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = clampedMd.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
        i++;
      } else {
        expect(code < 0xdc00 || code > 0xdfff).toBe(true);
      }
    }
  });

  it('parses fenced code blocks with language, blockquotes, and auto-detected entities without corrupting snake_case', () => {
    const md = [
      '> Quoted **important** note',
      'Ping @bob_rivera in #全球法布施 with $TON at 01:24 via /newbot https://gpui.dev/a_b',
      '```rust',
      'fn main() { println!("**literal** @nobody"); }',
      '```',
    ].join('\n');

    const parsed = parseMarkdownEntities(md);

    const pre = parsed.entities.find((e) => e.type === 'pre');
    expect(pre).toBeDefined();
    expect(pre?.language).toBe('rust');
    expect(extractEntityUtf16(parsed.text, pre!)).toBe('fn main() { println!("**literal** @nobody"); }');

    const quote = parsed.entities.find((e) => e.type === 'blockquote');
    expect(quote).toBeDefined();
    expect(extractEntityUtf16(parsed.text, quote!)).toBe('Quoted important note');

    const mention = parsed.entities.find((e) => e.type === 'mention');
    expect(extractEntityUtf16(parsed.text, mention!)).toBe('@bob_rivera');

    const hashtag = parsed.entities.find((e) => e.type === 'hashtag');
    expect(extractEntityUtf16(parsed.text, hashtag!)).toBe('#全球法布施');

    const cashtag = parsed.entities.find((e) => e.type === 'cashtag');
    expect(extractEntityUtf16(parsed.text, cashtag!)).toBe('$TON');

    const cmd = parsed.entities.find((e) => e.type === 'bot_command');
    expect(extractEntityUtf16(parsed.text, cmd!)).toBe('/newbot');

    const ts = parsed.entities.find((e) => e.type === 'timestamp');
    expect(ts?.seconds).toBe(84);

    const url = parsed.entities.find((e) => e.type === 'url');
    expect(extractEntityUtf16(parsed.text, url!)).toBe('https://gpui.dev/a_b');

    // Round-trip back to Markdown
    const roundTrip = serializeEntitiesToMarkdown(parsed.text, parsed.entities);
    expect(roundTrip).toContain('> Quoted **important** note');
    expect(roundTrip).toContain('```rust\nfn main() { println!("**literal** @nobody"); }\n```');
  });

  it('preserves intra-word and member-access __ verbatim while still parsing valid __underline__ and nested **__...__**', () => {
    const xssPayload =
      '<img src=x onerror="window.__xss=1"><svg onload="window.__xss=2">[click](javascript:window.__xss=3) 🚀 **AstralBold**';
    const parsed = parseMarkdownEntities(xssPayload);
    expect(parsed.text).toBe(
      '<img src=x onerror="window.__xss=1"><svg onload="window.__xss=2">[click](javascript:window.__xss=3) 🚀 AstralBold',
    );
    expect(parsed.entities.filter((e) => e.type === 'underline')).toEqual([]);
    expect(parsed.entities.filter((e) => e.type === 'italic')).toEqual([]);
    const bold = parsed.entities.find((e) => e.type === 'bold');
    expect(bold).toBeDefined();
    expect(extractEntityUtf16(parsed.text, bold!)).toBe('AstralBold');

    const identParsed = parseMarkdownEntities('foo__bar__baz window.__proto__ and __under__');
    expect(identParsed.text).toBe('foo__bar__baz window.__proto__ and under');
    const underlines = identParsed.entities.filter((e) => e.type === 'underline');
    expect(underlines.map((e) => extractEntityUtf16(identParsed.text, e))).toEqual(['under']);

    const nestedParsed = parseMarkdownEntities('**__粗体加下划线🚀__**');
    expect(nestedParsed.text).toBe('粗体加下划线🚀');
    expect(nestedParsed.entities.map((e) => e.type).sort()).toEqual(['bold', 'underline']);
  });

  it('enforces XSS-safe HTML escaping, blocks attribute breakouts in timestamp/custom_emoji, and tolerates malformed wire entities', () => {
    expect(isSafeEntityUrl('https://telegram.org')).toBe(true);
    expect(isSafeEntityUrl('tg://resolve?domain=BotFather')).toBe(true);
    expect(isSafeEntityUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeEntityUrl('data:text/html,<script>alert(1)</script>')).toBe(false);

    const malicious = 'Hello <script>alert("xss")</script> [click](javascript:alert(1)) [safe](https://gpui.dev)';
    const parsed = parseMarkdownEntities(malicious);
    const html = renderEntitiesToSafeHtml(parsed.text, parsed.entities);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('<a href="https://gpui.dev" target="_blank" rel="noopener noreferrer">safe</a>');

    // Stored XSS regression: attacker-supplied string in seconds / document_id must be coerced to integer 0!
    const xssAttrHtml = renderEntitiesToSafeHtml('01:23 😀', [
      {
        offset: 0,
        length: 5,
        entity_type: {
          type: 'Timestamp',
          value: { seconds: '0" onmouseover="alert(1)" data-x="' as unknown as number },
        },
      },
      {
        offset: 6,
        length: 2,
        entity_type: {
          type: 'CustomEmoji',
          value: { document_id: '1"><img src=x onerror=alert(1)>' as unknown as number },
        },
      },
    ]);
    expect(xssAttrHtml).not.toContain('onmouseover');
    expect(xssAttrHtml).not.toContain('onerror');
    expect(xssAttrHtml).not.toContain('<img');
    expect(xssAttrHtml).toContain('data-seconds="0"');
    expect(xssAttrHtml).toContain('data-document-id="0"');

    // Malformed wire entities without value or unknown type must NEVER throw TypeError
    expect(() =>
      fromWireMessageEntity({ offset: 0, length: 5, entity_type: { type: 'TextUrl' } as any }),
    ).not.toThrow();
    expect(() =>
      fromWireMessageEntity({ offset: 0, length: 5, entity_type: { type: 'UnknownFutureType' } as any }),
    ).not.toThrow();
    expect(
      renderEntitiesToSafeHtml('hello', [
        { offset: 0, length: 5, entity_type: { type: 'TextUrl' } as any },
        { offset: 0, length: 5 } as any,
      ]),
    ).toBe('hello');
  });
});

describe('@gpui-telegram/protocol — 3-State CJK IME Safety FSM', () => {
  it('suppresses Enter during Chromium composition (keydown before compositionend) and sends on next deliberate Enter', () => {
    const fsm = new ImeSafetyFsm({ sendByEnter: true });
    expect(fsm.getStateKind()).toBe('Idle');

    fsm.onCompositionStart('');
    fsm.onCompositionUpdate('nihao');
    expect(fsm.getStateKind()).toBe('Composing');

    // Chromium fires keydown(Enter, isComposing=true) BEFORE compositionend
    const duringComp = fsm.handleKeyDown({ key: 'Enter', isComposing: true }, { text: 'nihao' });
    expect(duringComp).toBe('ImeCandidateChosen');

    fsm.onCompositionEnd('你好');
    expect(fsm.getStateKind()).toBe('Committed');

    // User now presses deliberate Enter to send "你好"
    const deliberate = fsm.handleKeyDown({ key: 'Enter', isComposing: false }, { text: '你好' });
    expect(deliberate).toBe('SendMessage');
    expect(fsm.getStateKind()).toBe('Idle');
  });

  it('absorbs trailing Enter after compositionend in Safari/WebKit EVEN AFTER phonetic keyCode 229 keystrokes!', () => {
    const fsm = new ImeSafetyFsm({ sendByEnter: true });

    fsm.onCompositionStart('');
    // Real Safari/WebKit fires keyCode=229 ('Process') on every phonetic keystroke ('n', 'i')
    expect(
      fsm.handleKeyDown({ key: 'Process', keyCode: 229, isComposing: true }, { text: 'n' }),
    ).toBe('ImeCandidateChosen');
    fsm.onCompositionUpdate('ni');
    expect(
      fsm.handleKeyDown({ key: 'Process', keyCode: 229, isComposing: true }, { text: 'ni' }),
    ).toBe('ImeCandidateChosen');

    // Safari fires compositionend('你') FIRST, then trailing keydown(Enter, keyCode=13, isComposing=false)
    fsm.onCompositionEnd('你');
    expect(fsm.getStateKind()).toBe('Committed');
    expect(fsm.isJustCommitted()).toBe(true);

    const trailingEnter = fsm.handleKeyDown(
      { key: 'Enter', keyCode: 13, isComposing: false },
      { text: '你' },
    );
    expect(trailingEnter).toBe('ImeCandidateChosen');
    expect(fsm.getStateKind()).toBe('Idle');

    // Next deliberate Enter sends the message!
    const deliberateSend = fsm.handleKeyDown(
      { key: 'Enter', keyCode: 13, isComposing: false },
      { text: '你' },
    );
    expect(deliberateSend).toBe('SendMessage');
  });

  it('allows Shift+Enter to insert a newline immediately after mouse/number-key IME candidate commit', () => {
    const fsm = new ImeSafetyFsm({ sendByEnter: true });

    fsm.onCompositionStart('');
    fsm.onCompositionUpdate('nihao');
    // User clicks candidate #1 with mouse -> compositionend without Enter keydown
    fsm.onCompositionEnd('你好');
    expect(fsm.isJustCommitted()).toBe(true);

    // User immediately presses Shift+Enter -> must insert newline rather than being swallowed!
    const shiftEnter = fsm.handleKeyDown(
      { key: 'Enter', shiftKey: true, isComposing: false },
      { text: '你好' },
    );
    expect(shiftEnter).toBe('InsertNewline');
    expect(fsm.getStateKind()).toBe('Idle');
  });

  it('handles keyCode 229, Shift+Enter newline, Ctrl/Cmd+Enter mode, and empty input guard', () => {
    const fsm = new ImeSafetyFsm({ sendByEnter: true });

    expect(fsm.handleKeyDown({ key: 'Process', keyCode: 229 }, { text: 'a' })).toBe('ImeCandidateChosen');
    fsm.resetCommitFence();

    expect(fsm.handleKeyDown({ key: 'Enter', shiftKey: true }, { text: 'line 1' })).toBe('InsertNewline');
    expect(fsm.handleKeyDown({ key: 'Enter' }, { text: '   ', hasAttachment: false })).toBe('None');
    expect(fsm.handleKeyDown({ key: 'Enter' }, { text: '', hasAttachment: true })).toBe('SendMessage');

    fsm.setSendByEnter(false);
    expect(fsm.handleKeyDown({ key: 'Enter' }, { text: 'hello' })).toBe('InsertNewline');
    expect(fsm.handleKeyDown({ key: 'Enter', ctrlKey: true }, { text: 'hello' })).toBe('SendMessage');
    expect(fsm.handleKeyDown({ key: 'Enter', metaKey: true }, { text: 'hello' })).toBe('SendMessage');
  });
});

describe('@gpui-telegram/protocol — 100-Bar 5-Bit Voice Waveform Codec', () => {
  it('packs 100 5-bit bars into exactly 63 bytes and round-trips losslessly', () => {
    const bars = new Uint8Array(TELEGRAM_WAVEFORM_BARS);
    for (let i = 0; i < TELEGRAM_WAVEFORM_BARS; i++) {
      bars[i] = (i * 7 + 3) % 32;
    }

    const encoded = encodeWaveform5Bit(bars);
    expect(encoded.byteLength).toBe(TELEGRAM_WAVEFORM_BYTES); // 63 bytes

    const decoded = decodeWaveform5Bit(encoded);
    expect(decoded.length).toBe(TELEGRAM_WAVEFORM_BARS);
    expect(Array.from(decoded)).toEqual(Array.from(bars));

    const b64 = encodeWaveformBase64(bars);
    expect(Array.from(decodeWaveformBase64(b64))).toEqual(Array.from(bars));
  });

  it('extracts normalized 100-bar waveforms from Float32 PCM audio samples', () => {
    const pcm = new Float32Array(4800);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.sin((i / 4800) * Math.PI * 12) * (i / pcm.length);
    }

    const bars = extractWaveformBarsFromPcm(pcm);
    expect(bars.length).toBe(100);
    expect(Math.max(...bars)).toBeGreaterThan(15);
    expect(Math.max(...bars)).toBeLessThanOrEqual(31);

    const packed = extractWaveformFromFloat32Pcm(pcm);
    expect(packed.byteLength).toBe(63);
  });
});

describe('@gpui-telegram/protocol — WebCrypto E2EE & PTS Sync Invariants', () => {
  it('performs ECDH P-256 + HKDF-SHA256 + AES-256-GCM secret message round-trip and rejects tampered ciphertext', async () => {
    const alice = await generateE2eeIdentity('alice-web');
    const bob = await generateE2eeIdentity('bob-web');

    const bobSpk = await generateE2eeIdentity('bob-spk');
    const sig = await signPreKeyPublic(bob.signingKeyPair.privateKey, bobSpk.dhKeyPair.publicKeyBase64);
    expect(await verifyPreKeySignature(bob.signingKeyPair.publicKeyBase64, bobSpk.dhKeyPair.publicKeyBase64, sig)).toBe(true);
    expect(await verifyPreKeySignature(alice.signingKeyPair.publicKeyBase64, bobSpk.dhKeyPair.publicKeyBase64, sig)).toBe(false);

    const aliceShared = await deriveSharedAesGcmKey(alice.dhKeyPair.privateKey, bob.dhKeyPair.publicKeyBase64);
    const bobShared = await deriveSharedAesGcmKey(bob.dhKeyPair.privateKey, alice.dhKeyPair.publicKeyBase64);

    const fpAlice = await computeSafetyNumberEmojis(alice.dhKeyPair.publicKeyBase64, bob.dhKeyPair.publicKeyBase64);
    const fpBob = await computeSafetyNumberEmojis(bob.dhKeyPair.publicKeyBase64, alice.dhKeyPair.publicKeyBase64);
    expect(fpAlice.emojis).toEqual(fpBob.emojis);
    expect(fpAlice.emojis.every((e) => (E2EE_SAFETY_EMOJIS as readonly string[]).includes(e))).toBe(true);

    const secretText = 'Top Secret E2EE Message 🔐 绝密通信测试!';
    const envelope = await encryptSecretMessage({
      aesKey: aliceShared,
      plaintext: secretText,
      senderUserId: 1001,
      senderIdentityKey: alice.dhKeyPair.publicKeyBase64,
      recipientUserId: 1002,
    });

    const decrypted = await decryptSecretMessage(bobShared, envelope, 1002);
    expect(decrypted).toBe(secretText);

    // Tamper with AAD recipient ID -> must fail GCM authentication!
    await expect(decryptSecretMessage(bobShared, envelope, 9999)).rejects.toThrow();

    // Tamper with ciphertext byte -> must fail GCM tag verification!
    if (envelope.kind.kind === 'PairwiseFanout') {
      const origB64 = envelope.kind.payload.recipients[0]!.ciphertext;
      const bytes = Buffer.from(origB64, 'base64');
      bytes[bytes.length - 1] ^= 0xff;
      envelope.kind.payload.recipients[0]!.ciphertext = bytes.toString('base64');
    }
    await expect(decryptSecretMessage(bobShared, envelope, 1002)).rejects.toThrow();
  });

  it('evaluates PTS continuity, gap ranges, stale duplicates, and generative progress clamping', () => {
    expect(isPtsContinuous({ pts: 6, pts_count: 1 }, 5)).toBe(true);
    expect(detectPtsGap({ pts: 6, pts_count: 1 }, 5)).toBeNull();

    expect(isPtsContinuous({ pts: 9, pts_count: 1 }, 5)).toBe(false);
    expect(detectPtsGap({ pts: 9, pts_count: 1 }, 5)).toEqual({ fromPts: 6, toPts: 8 });

    expect(isPtsStaleOrDuplicate({ pts: 5, pts_count: 1 }, 5)).toBe(true);
    expect(clampGenerativeProgress(50, 0)).toBe(0);
    expect(clampGenerativeProgress(75, 100)).toBe(0.75);
  });

  it('encodes real ISO/IEC 18004 scannable QR code matrices and SVGs with valid finder patterns', () => {
    const payload = 'https://api.ombhrum.com/api/auth/oauth/start?provider=alipay&attempt=abc123';
    const mat = encodeQrMatrix(payload, 'Q');

    // ISO/IEC 18004 sizes are always 17 + 4*version (21, 25, 29, ...)
    expect(mat.size).toBeGreaterThanOrEqual(21);
    expect((mat.size - 17) % 4).toBe(0);
    expect(mat.modules.length).toBe(mat.size);

    // Top-left 7x7 finder pattern must be dark on border, white on inner ring, dark on 3x3 core
    expect(mat.modules[0][0]).toBe(true);
    expect(mat.modules[0][6]).toBe(true);
    expect(mat.modules[1][1]).toBe(false);
    expect(mat.modules[3][3]).toBe(true);
    // Separator around top-left finder
    expect(mat.modules[0][7]).toBe(false);
    expect(mat.modules[7][0]).toBe(false);

    // Top-right & bottom-left finder centers
    expect(mat.modules[3][mat.size - 4]).toBe(true);
    expect(mat.modules[mat.size - 4][3]).toBe(true);

    // Alternating timing pattern along row 6
    expect(mat.modules[6][8]).toBe(true);
    expect(mat.modules[6][9]).toBe(false);

    // SVG rendering produces crisp <svg> with <path> and proper viewBox
    const svg = renderQrCodeSvg(payload, { sizePx: 240, ecLevel: 'Q' });
    expect(svg).toContain('<svg');
    expect(svg).toContain('<path');
    expect(svg).toContain('width="240"');
  });
});
