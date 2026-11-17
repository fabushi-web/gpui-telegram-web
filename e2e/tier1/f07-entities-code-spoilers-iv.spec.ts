import type { Locator, Page } from '@playwright/test';
import {
  bilingualRegex,
  BILINGUAL_PATTERNS,
  DATA_ATTRS,
  DOM,
  expect,
  getBaseUrl,
  scopedButton,
  selectChat,
  sendTextMessage,
  test,
} from '../helpers';

async function selectWritableChat(
  page: Page,
  excludeChatIds: ReadonlySet<string> = new Set(),
  excludeTitlePattern?: RegExp,
): Promise<{ row: Locator; chatId: string; title: string }> {
  const chatList = page.locator(DOM.chatList);
  if (!(await chatList.isVisible())) {
    const backBtn = page.locator(DOM.btnBackToChats);
    if (await backBtn.isVisible()) {
      await backBtn.click();
    }
  }
  await expect(chatList).toBeVisible();

  const rows = chatList.locator(DOM.chatRow);
  await expect(rows.first()).toBeVisible();
  const total = await rows.count();

  for (let i = 0; i < total; i++) {
    const candidate = rows.nth(i);
    const id = (await candidate.getAttribute(DATA_ATTRS.chatId)) ?? '';
    if (!id || excludeChatIds.has(id)) {
      continue;
    }
    const rowText = ((await candidate.textContent()) ?? '').trim();
    if (excludeTitlePattern && excludeTitlePattern.test(rowText)) {
      continue;
    }
    const row = await selectChat(page, id);
    const title =
      ((await page.locator(DOM.chatHeaderTitle).textContent()) ?? '').trim();
    if (excludeTitlePattern && excludeTitlePattern.test(title)) {
      continue;
    }
    const composer = page.locator(DOM.messageComposerInput);
    if ((await composer.isVisible()) && (await composer.isEditable())) {
      return { row, chatId: id, title };
    }
  }

  throw new Error(
    'Expected at least one matching writable chat with #message-composer-input in #chat-list',
  );
}

test.describe('F7 — Rich Text Entities, Code Blocks, Spoilers, Link Previews & Instant View', () => {
  test('F7-1: UTF-16 Markdown/Entity rendering (bold, italic, underline, strikethrough, inline code)', async ({
    authPage,
  }) => {
    await selectWritableChat(authPage);

    const mdPayload =
      'Entity check: **boldAlpha** *italicBeta* __underlineGamma__ ~~strikeDelta~~ `inlineOmega`';
    const composer = authPage.locator(DOM.messageComposerInput);
    await composer.click();
    await composer.fill(mdPayload);
    const sendBtn = authPage.locator(DOM.btnSendMessage);
    if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
      await sendBtn.click();
    } else {
      await composer.press('Enter');
    }

    const formattedBubble = authPage
      .locator(`${DOM.messageList} ${DOM.messageBubble}`)
      .filter({ hasText: 'boldAlpha' })
      .last();
    await expect(formattedBubble).toBeVisible();

    // 1. Bold
    const boldNode = formattedBubble
      .locator('strong, b, [data-entity-type*="bold" i]')
      .filter({ hasText: 'boldAlpha' })
      .first();
    await expect(boldNode).toBeVisible();
    const boldWeight = await boldNode.evaluate((el: Element) => {
      const fw = window.getComputedStyle(el).fontWeight;
      return fw === 'bold' ? 700 : Number.parseInt(fw, 10);
    });
    expect(boldWeight).toBeGreaterThanOrEqual(600);

    // 2. Italic
    const italicNode = formattedBubble
      .locator('em, i, [data-entity-type*="italic" i]')
      .filter({ hasText: 'italicBeta' })
      .first();
    await expect(italicNode).toBeVisible();
    const italicStyle = await italicNode.evaluate(
      (el: Element) => window.getComputedStyle(el).fontStyle,
    );
    expect(italicStyle).toBe('italic');

    // 3. Underline
    const underlineCheck = await formattedBubble.evaluate((root: Element) => {
      const semantic = root.querySelector(
        'u, ins, [data-entity-type*="underline" i]',
      );
      if (semantic && (semantic.textContent ?? '').includes('underlineGamma')) {
        return true;
      }
      const spans = Array.from(root.querySelectorAll('*'));
      return spans.some(
        (el) =>
          (el.textContent ?? '').trim() === 'underlineGamma' &&
          window.getComputedStyle(el).textDecorationLine.includes('underline'),
      );
    });
    expect(underlineCheck).toBe(true);

    // 4. Strikethrough
    const strikeCheck = await formattedBubble.evaluate((root: Element) => {
      const semantic = root.querySelector(
        's, del, strike, [data-entity-type*="strike" i]',
      );
      if (semantic && (semantic.textContent ?? '').includes('strikeDelta')) {
        return true;
      }
      const spans = Array.from(root.querySelectorAll('*'));
      return spans.some(
        (el) =>
          (el.textContent ?? '').trim() === 'strikeDelta' &&
          window.getComputedStyle(el).textDecorationLine.includes('line-through'),
      );
    });
    expect(strikeCheck).toBe(true);

    // 5. Inline Code
    const codeNode = formattedBubble
      .locator(
        ':not(pre) > code, [data-entity-type="code"], [data-entity-type="MessageEntityCode"], [data-entity-type*="code" i]',
      )
      .filter({ hasText: 'inlineOmega' })
      .first();
    await expect(codeNode).toBeVisible();
    const codeFont = await codeNode.evaluate(
      (el: Element) => window.getComputedStyle(el).fontFamily,
    );
    expect(codeFont).toMatch(
      /mono|consolas|menlo|courier|fira|jetbrains|source\s*code|code/i,
    );

    // 6. Delimiter stripping
    const renderedText = await formattedBubble.innerText();
    expect(renderedText).not.toContain('**boldAlpha**');
    expect(renderedText).not.toContain('~~strikeDelta~~');
  });

  test('F7-2: Fenced ts code block syntax formatting and Copy Code clipboard action', async ({
    authPage,
  }) => {
    await authPage
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: getBaseUrl(),
      });

    await selectWritableChat(authPage);

    const codeBody =
      'const ptsVersion: number = 108;\nexport function verifyPts(): number { return ptsVersion; }';
    const fencedPayload = `\`\`\`ts\n${codeBody}\n\`\`\``;

    const composer = authPage.locator(DOM.messageComposerInput);
    await composer.click();
    await composer.fill(fencedPayload);
    const sendBtn = authPage.locator(DOM.btnSendMessage);
    if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
      await sendBtn.click();
    } else {
      await composer.press('Enter');
    }

    const codeBubble = authPage
      .locator(`${DOM.messageList} ${DOM.messageBubble}`)
      .filter({ hasText: 'ptsVersion' })
      .last();
    await expect(codeBubble).toBeVisible();

    const preBlock = codeBubble.locator('pre code, pre').first();
    await expect(preBlock).toBeVisible();
    const preText = await preBlock.innerText();
    expect(preText).toContain('const ptsVersion: number = 108;');
    expect(preText).not.toContain('```');

    // Language badge / class check + monospace styling
    const codeMeta = await codeBubble.evaluate((el: Element) => {
      const codeEl = el.querySelector('pre code, pre');
      const fontFamily = codeEl ? window.getComputedStyle(codeEl).fontFamily : '';
      const hasLangAttrOrClass =
        el.querySelector(
          '[data-language="ts" i], [data-lang="ts" i], code[class*="ts" i], [class*="language-ts" i]',
        ) !== null;
      const fullTxt = el.textContent ?? '';
      return {
        fontFamily,
        hasLangIndicator: hasLangAttrOrClass || /\bts\b|typescript/i.test(fullTxt),
      };
    });
    expect(codeMeta.fontFamily).toMatch(
      /mono|consolas|menlo|courier|fira|jetbrains|source\s*code|code/i,
    );
    expect(codeMeta.hasLangIndicator).toBe(true);

    // Copy Code button -> verify clipboard contains exact code snippet
    const copyCodeBtn = scopedButton(
      codeBubble,
      bilingualRegex('copy', '复制'),
    ).first();
    await expect(copyCodeBtn).toBeVisible();
    await copyCodeBtn.click();

    await expect
      .poll(
        async () =>
          authPage.evaluate(() => navigator.clipboard.readText()),
        { message: 'Expected Copy Code to write TypeScript snippet to clipboard' },
      )
      .toContain('const ptsVersion: number = 108;');
  });

  test('F7-3: Click-to-reveal ||spoiler|| text and collapsible > blockquote', async ({
    authPage,
  }) => {
    await selectWritableChat(authPage);

    // Part A: ||spoiler|| click-to-reveal
    const composer = authPage.locator(DOM.messageComposerInput);
    await composer.click();
    await composer.fill('Classified token: ||OMEGA-SPOILER-7749||');
    const sendBtn = authPage.locator(DOM.btnSendMessage);
    if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
      await sendBtn.click();
    } else {
      await composer.press('Enter');
    }

    const spoilerBubble = authPage
      .locator(`${DOM.messageList} ${DOM.messageBubble}`)
      .filter({ hasText: 'Classified token:' })
      .last();
    await expect(spoilerBubble).toBeVisible();
    expect(await spoilerBubble.innerText()).not.toContain('||');

    const spoilerEl = spoilerBubble
      .locator(
        '[data-spoiler], [data-entity-type*="spoiler" i], [class*="spoiler" i], [role="button"]',
      )
      .filter({ hasText: 'OMEGA-SPOILER-7749' })
      .or(
        spoilerBubble.locator(
          '[data-spoiler], [data-entity-type*="spoiler" i], [class*="spoiler" i]',
        ),
      )
      .first();
    await expect(spoilerEl).toBeVisible();

    const readSpoilerState = async () =>
      spoilerEl.evaluate((el: Element) => {
        const st = window.getComputedStyle(el);
        const dataRevealed = el.getAttribute('data-revealed');
        const ariaExpanded = el.getAttribute('aria-expanded');
        const cls = el.className;
        const filterStr = st.filter;
        const colorStr = st.color;
        const isTransparentText =
          colorStr === 'transparent' ||
          /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)/.test(colorStr);
        return {
          signature: `${dataRevealed}|${ariaExpanded}|${cls}|${filterStr}|${colorStr}`,
          obscured:
            dataRevealed === 'false' ||
            ariaExpanded === 'false' ||
            /hidden|concealed|masked|blur|obscured|unrevealed/i.test(cls) ||
            ( !/revealed|visible|open/i.test(cls) &&
              (filterStr.includes('blur') ||
                isTransparentText ||
                el.hasAttribute('data-spoiler') ||
                /spoiler/i.test(cls)) ),
        };
      });

    const beforeSpoiler = await readSpoilerState();
    expect(beforeSpoiler.obscured).toBe(true);

    await spoilerEl.click();

    await expect
      .poll(async () => (await readSpoilerState()).signature, {
        message: 'Expected clicking ||spoiler|| element to reveal spoiler state',
      })
      .not.toBe(beforeSpoiler.signature);

    await expect(spoilerBubble).toContainText('OMEGA-SPOILER-7749');

    // Part B: Collapsible > blockquote
    const quoteLines = Array.from(
      { length: 8 },
      (_, idx) =>
        `> Blockquote line #${idx + 1} — hexagonal protocol specification detail`,
    ).join('\n');

    await composer.click();
    await composer.fill(quoteLines);
    if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
      await sendBtn.click();
    } else {
      await composer.press('Enter');
    }

    const quoteBubble = authPage
      .locator(`${DOM.messageList} ${DOM.messageBubble}`)
      .filter({ hasText: 'Blockquote line #1' })
      .last();
    await expect(quoteBubble).toBeVisible();

    const blockquoteEl = quoteBubble
      .locator('blockquote, [data-entity-type*="blockquote" i]')
      .first();
    await expect(blockquoteEl).toBeVisible();

    const quoteToggle = scopedButton(
      quoteBubble,
      bilingualRegex(
        'expand|collapse|show\\s*more|show\\s*less|more|less',
        '展开|收起|折叠|更多',
      ),
    )
      .or(
        quoteBubble.locator(
          '[data-testid*="blockquote" i] button, blockquote[role="button"], blockquote[data-collapsible]',
        ),
      )
      .first();

    const readQuoteSnapshot = async () =>
      blockquoteEl.evaluate((el: Element) => {
        const rect = el.getBoundingClientRect();
        return `${Math.round(rect.height)}|${el.getAttribute('data-collapsed')}|${el.getAttribute('aria-expanded')}|${el.className}`;
      });

    const quoteSnap0 = await readQuoteSnapshot();
    if ((await quoteToggle.count()) > 0 && (await quoteToggle.isVisible())) {
      await quoteToggle.click();
    } else {
      await blockquoteEl.click();
    }

    await expect
      .poll(readQuoteSnapshot, {
        message: 'Expected collapsible > blockquote toggle to mutate height or state',
      })
      .not.toBe(quoteSnap0);

    const quoteSnap1 = await readQuoteSnapshot();
    if ((await quoteToggle.count()) > 0 && (await quoteToggle.isVisible())) {
      await quoteToggle.click();
    } else {
      await blockquoteEl.click();
    }
    await expect.poll(readQuoteSnapshot).not.toBe(quoteSnap1);
  });

  test('F7-4: Clickable @mention, #hashtag, and https:// URL entities inside [data-testid="message-bubble"]', async ({
    authPage,
  }) => {
    await selectWritableChat(authPage, new Set(), /BotFather/i);

    const entityMsg =
      'Ping @BotFather regarding #pts_sync_v2 spec at https://example.org/protocol-v2';
    const bubble = await sendTextMessage(authPage, entityMsg);

    // 1. URL Entity
    const urlLink = bubble
      .locator('a[href^="https://example.org/protocol-v2"]')
      .first();
    await expect(urlLink).toBeVisible();
    const targetAttr = await urlLink.getAttribute('target');
    const relAttr = (await urlLink.getAttribute('rel')) ?? '';

    if (targetAttr === '_blank') {
      expect(relAttr.toLowerCase()).toContain('noopener');
    } else {
      await urlLink.click();
      const extDialog = authPage.locator('[role="dialog"]:visible').first();
      await expect(extDialog).toBeVisible();
      const cancelBtn = scopedButton(
        extDialog,
        BILINGUAL_PATTERNS.cancel,
      ).first();
      await expect(cancelBtn).toBeVisible();
      await cancelBtn.click();
    }

    // 2. #hashtag Entity
    const hashtagEl = bubble
      .locator(
        'a, button, [role="button"], [data-entity-type*="hashtag" i], [class*="hashtag" i]',
      )
      .filter({ hasText: '#pts_sync_v2' })
      .first();
    await expect(hashtagEl).toBeVisible();
    await hashtagEl.click();

    await expect
      .poll(
        async () => {
          const inChatInput = authPage.locator(DOM.inChatSearchInput);
          if (await inChatInput.isVisible()) {
            const v = await inChatInput.inputValue();
            if (v.includes('pts_sync_v2')) return true;
          }
          const globalInput = authPage.locator(DOM.globalSearchInput);
          if (await globalInput.isVisible()) {
            const gv = await globalInput.inputValue();
            if (gv.includes('pts_sync_v2')) return true;
          }
          return false;
        },
        {
          message:
            'Expected clicking #hashtag entity to populate In-Chat Search or Global Search',
        },
      )
      .toBe(true);

    if (await authPage.locator(DOM.inChatSearchInput).isVisible()) {
      await authPage.keyboard.press('Escape');
    }

    // 3. @mention Entity
    const mentionEl = bubble
      .locator(
        'a, button, [role="button"], [data-entity-type*="mention" i], [class*="mention" i]',
      )
      .filter({ hasText: '@BotFather' })
      .first();
    await expect(mentionEl).toBeVisible();
    await mentionEl.click();

    await expect
      .poll(
        async () => {
          const headerTitle =
            (await authPage.locator(DOM.chatHeaderTitle).textContent()) ?? '';
          if (/BotFather/i.test(headerTitle)) {
            return true;
          }
          const profileDialog = authPage.locator('[role="dialog"]:visible');
          if ((await profileDialog.count()) > 0) {
            return /BotFather/i.test(await profileDialog.first().innerText());
          }
          const rightCol = authPage.locator(DOM.rightColumn);
          if (await rightCol.isVisible()) {
            return /BotFather/i.test(await rightCol.innerText());
          }
          return false;
        },
        {
          message:
            'Expected clicking @BotFather mention to navigate to @BotFather chat or open peer profile',
        },
      )
      .toBe(true);
  });

  test('F7-5: OpenGraph WebPage link preview card and #instant-view-modal reader controls', async ({
    authPage,
  }) => {
    await selectWritableChat(authPage);

    const urlBubble = await sendTextMessage(
      authPage,
      'Read https://telegram.org/blog/instant-view-2',
    );

    const ivBtnInSent = scopedButton(
      urlBubble,
      bilingualRegex('instant\\s*view', '即时预览|即时浏览'),
    )
      .or(
        urlBubble.locator(
          '[data-testid*="instant-view" i], button:has-text("Instant View"), button:has-text("即时")',
        ),
      )
      .first();

    // Verify OpenGraph preview card renders on the sent URL bubble
    await expect
      .poll(
        async () => {
          const cardCount = await urlBubble
            .locator(
              '[data-testid*="webpage" i], [data-testid*="link-preview" i], [data-testid*="preview" i], [class*="webpage" i], [class*="preview" i]',
            )
            .count();
          const btnCount = await ivBtnInSent.count();
          return cardCount > 0 || btnCount > 0;
        },
        {
          message:
            'Expected OpenGraph WebPage link preview card on sent article URL bubble',
          timeout: 8_000,
        },
      )
      .toBe(true);

    await expect(ivBtnInSent).toBeVisible();
    await ivBtnInSent.click();

    const ivModal = authPage.locator(DOM.instantViewModal);
    await expect(ivModal).toBeVisible();

    const heading = ivModal
      .locator('h1, h2, h3, [data-testid*="title" i]')
      .first();
    await expect(heading).toBeVisible();
    await expect(heading).not.toBeEmpty();

    // Exercise Instant View reader appearance control (font size A+/A-, font family, or reader theme)
    const readArticleAppearance = async () =>
      ivModal.evaluate((modalEl: Element) => {
        const body =
          modalEl.querySelector('article, [data-testid*="content" i], main, p') ??
          modalEl;
        const st = window.getComputedStyle(body);
        const modalSt = window.getComputedStyle(modalEl);
        const attrs = Array.from(modalEl.attributes)
          .map((a) => `${a.name}=${a.value}`)
          .join(';');
        return `${st.fontSize}|${st.fontFamily}|${st.color}|${modalSt.backgroundColor}|${attrs}`;
      });

    const appearanceBefore = await readArticleAppearance();

    const readerControl = ivModal
      .locator(
        '[data-testid*="font" i], [data-testid*="theme" i], [data-testid*="size" i], button[aria-label*="font" i], button[aria-label*="size" i], button[aria-label*="theme" i], button[aria-label*="字号" i], button[aria-label*="主题" i]',
      )
      .or(
        scopedButton(
          ivModal,
          /A\+|A-|serif|sans|sepia|dark|light|font|size|字号|字体|护眼|夜间|日间/i,
        ),
      )
      .first();

    await expect(readerControl).toBeVisible();
    await readerControl.click();

    await expect
      .poll(readArticleAppearance, {
        message:
          'Expected Instant View reader control to mutate article typography or theme',
      })
      .not.toBe(appearanceBefore);

    // Close #instant-view-modal
    const closeIvBtn = scopedButton(ivModal, BILINGUAL_PATTERNS.cancel)
      .or(
        ivModal.locator(
          'button[aria-label*="close" i], button[aria-label*="关闭"]',
        ),
      )
      .first();

    if ((await closeIvBtn.count()) > 0 && (await closeIvBtn.isVisible())) {
      await closeIvBtn.click();
    } else {
      await authPage.keyboard.press('Escape');
    }

    await expect(ivModal).toBeHidden();
  });
});
