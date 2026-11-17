import type { Locator, Page } from '@playwright/test';
import {
  bilingualRegex,
  DOM,
  expect,
  openBurgerMenu,
  openContextMenuAndClick,
  scopedButton,
  scopedMenuItem,
  scopedTextbox,
  selectChat,
  test,
  type BilingualActionKey,
} from '../helpers';

async function pickVisibleFirst(
  primary: Locator,
  fallback: Locator,
): Promise<Locator> {
  if ((await primary.count()) > 0 && (await primary.first().isVisible())) {
    return primary.first();
  }
  return fallback.first();
}

async function selectGroupOrWritableChat(page: Page): Promise<Locator> {
  const chatList = page.locator(DOM.chatList);
  await expect(chatList).toBeVisible();

  const rows = chatList.locator(DOM.chatRow);
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);

  const maxScan = Math.min(count, 12);

  // Pass 1: prefer a writable Group chat (rich voter list for visible-voter polls)
  for (let i = 0; i < maxScan; i++) {
    const candidate = rows.nth(i);
    if (!(await candidate.isVisible())) continue;
    const text = (await candidate.innerText()).trim();
    if (/botfather|saved messages|收藏夹|已保存消息/i.test(text)) continue;

    const selected = await selectChat(page, i);
    const topicList = page.locator(DOM.forumTopicList);
    const composer = page.locator(DOM.messageComposerInput);
    if ((await topicList.isVisible()) && !(await composer.isVisible())) {
      const firstTopic = page.locator(DOM.forumTopicItem).first();
      if (await firstTopic.isVisible()) {
        await firstTopic.click();
      }
    }

    const headerStatus = (
      await page.locator(DOM.chatHeaderStatus).innerText()
    ).trim();
    if (
      /member|成员/i.test(headerStatus) &&
      (await composer.isVisible()) &&
      (await page.locator(DOM.btnAttachMenu).isVisible())
    ) {
      return selected;
    }
  }

  // Pass 2: any writable chat with #btn-attach-menu visible
  for (let i = 0; i < maxScan; i++) {
    const selected = await selectChat(page, i);
    const composer = page.locator(DOM.messageComposerInput);
    if (
      (await composer.isVisible()) &&
      (await page.locator(DOM.btnAttachMenu).isVisible())
    ) {
      return selected;
    }
  }

  await expect(page.locator(DOM.messageComposerInput)).toBeVisible();
  await expect(page.locator(DOM.btnAttachMenu)).toBeVisible();
  return rows.first();
}

async function openAttachMenuAndPick(
  page: Page,
  pattern: BilingualActionKey | RegExp,
): Promise<boolean> {
  const attachBtn = page.locator(DOM.btnAttachMenu);
  await expect(attachBtn).toBeVisible();
  await attachBtn.click();

  const menuSurface = page
    .locator('[role="menu"], [role="dialog"], [data-testid*="attach" i]')
    .filter({ hasNot: page.locator(DOM.chatList) })
    .first();

  const itemInMenu = scopedMenuItem(menuSurface, pattern).first();
  if ((await itemInMenu.count()) > 0 && (await itemInMenu.isVisible())) {
    await itemInMenu.click();
    return true;
  }

  const pageItem = scopedMenuItem(page, pattern).first();
  if ((await pageItem.count()) > 0 && (await pageItem.isVisible())) {
    await pageItem.click();
    return true;
  }

  await page.keyboard.press('Escape');
  return false;
}

async function openCreatePollModal(page: Page): Promise<Locator> {
  const modal = page.locator(DOM.modalCreatePoll);
  if (await modal.isVisible()) {
    return modal;
  }

  const picked = await openAttachMenuAndPick(page, 'poll');
  if (!picked && !(await modal.isVisible())) {
    const directPollBtn = scopedButton(
      page.locator(DOM.middleColumn),
      'poll',
    ).first();
    if ((await directPollBtn.count()) > 0 && (await directPollBtn.isVisible())) {
      await directPollBtn.click();
    }
  }

  await expect(modal).toBeVisible();
  return modal;
}

interface FillPollParams {
  question: string;
  options: string[];
  anonymous?: boolean;
  quizMode?: boolean;
  correctIndex?: number;
  explanation?: string;
}

async function fillPollModalFields(
  modal: Locator,
  params: FillPollParams,
): Promise<void> {
  // 1. Question field (prioritize semantic textbox over first generic input)
  const questionInput = await pickVisibleFirst(
    scopedTextbox(
      modal,
      bilingualRegex('question|ask|title|topic', '问题|提问|标题|题目'),
    ),
    modal.locator('input[type="text"], textarea'),
  );
  await expect(questionInput).toBeVisible();
  await questionInput.fill(params.question);

  // 2. Anonymous voting toggle
  if (params.anonymous !== undefined) {
    const anonPattern = bilingualRegex('anonymous', '匿名');
    const anonCheckboxOrSwitch = modal
      .getByRole('checkbox', { name: anonPattern })
      .or(modal.getByRole('switch', { name: anonPattern }));
    const anonControl = await pickVisibleFirst(
      anonCheckboxOrSwitch,
      modal
        .getByLabel(anonPattern)
        .or(modal.locator('label, button').filter({ hasText: anonPattern })),
    );

    await expect(anonControl).toBeVisible();
    const isCurrentlyAnon = await anonControl.evaluate((el) => {
      if (el instanceof HTMLInputElement) return el.checked;
      const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
      if (aria !== null) return aria === 'true';
      const nested = el.querySelector('input[type="checkbox"]');
      return nested instanceof HTMLInputElement ? nested.checked : false;
    });

    if (isCurrentlyAnon !== params.anonymous) {
      await anonControl.click();
    }
  }

  // 3. Quiz Mode toggle
  if (params.quizMode) {
    const quizPattern = bilingualRegex('quiz', '测验|问答|答题');
    const quizRoleControl = modal
      .getByRole('checkbox', { name: quizPattern })
      .or(modal.getByRole('switch', { name: quizPattern }))
      .or(modal.getByRole('tab', { name: quizPattern }))
      .or(modal.getByRole('radio', { name: quizPattern }));
    const quizControl = await pickVisibleFirst(
      quizRoleControl,
      modal
        .getByLabel(quizPattern)
        .or(modal.locator('label, button').filter({ hasText: quizPattern })),
    );

    await expect(quizControl).toBeVisible();
    const alreadyQuiz = await quizControl.evaluate((el) => {
      if (el instanceof HTMLInputElement) return el.checked;
      const nested = el.querySelector(
        'input[type="checkbox"], input[type="radio"]',
      );
      if (nested instanceof HTMLInputElement) return nested.checked;
      return (
        el.getAttribute('aria-checked') === 'true' ||
        el.getAttribute('aria-selected') === 'true' ||
        el.getAttribute('aria-pressed') === 'true'
      );
    });
    if (!alreadyQuiz) {
      await quizControl.click();
    }
  }

  // 4. Poll options
  const resolveOptionInputs = async (): Promise<Locator> => {
    const explicit = scopedTextbox(
      modal,
      bilingualRegex('option|choice|answer', '选项|候选|答案'),
    );
    if ((await explicit.count()) >= 1) {
      return explicit;
    }
    return modal
      .locator('input[type="text"], textarea')
      .filter({
        hasNot: modal.locator(
          '[placeholder*="explanation" i], [placeholder*="solution" i], [placeholder*="解析" i], [placeholder*="说明" i]',
        ),
      });
  };

  for (let i = 0; i < params.options.length; i++) {
    let optInputs = await resolveOptionInputs();
    // Determine offset if generic fallback includes questionInput at index 0
    const firstVal =
      (await optInputs.count()) > 0
        ? await optInputs.first().inputValue()
        : '';
    const offset = firstVal === params.question ? 1 : 0;

    if ((await optInputs.count()) <= i + offset) {
      const addOptBtn = scopedButton(
        modal,
        bilingualRegex(
          'add.*option|new.*option|\\+.*option|add choice',
          '添加选项|新增选项|增加选项|添加',
        ),
      ).first();
      if ((await addOptBtn.count()) > 0 && (await addOptBtn.isVisible())) {
        await addOptBtn.click();
      }
      optInputs = await resolveOptionInputs();
    }

    const targetOpt = optInputs.nth(i + offset);
    await expect(targetOpt).toBeVisible();
    await targetOpt.fill(params.options[i]);
  }

  // 5. Select correct option in Quiz Mode (excluding any Quiz Mode radio toggle itself)
  if (params.quizMode && params.correctIndex !== undefined) {
    const correctSelectors = modal
      .locator(
        [
          'input[type="radio"]:not([aria-label*="quiz" i]):not([aria-label*="测验"]):not([name*="mode" i])',
          '[role="radio"]:not([aria-label*="quiz" i]):not([aria-label*="测验"])',
          '[data-testid*="correct" i]',
          'button[aria-label*="correct" i]',
          'button[aria-label*="正确" i]',
        ].join(', '),
      )
      .filter({
        hasNotText: /\bquiz\b|测验|regular\s*poll|普通投票/i,
      });
    await expect(correctSelectors.nth(params.correctIndex)).toBeVisible();
    await correctSelectors.nth(params.correctIndex).click();
  }

  // 6. Quiz explanation (strictly prioritize semantic explanation textbox so Question textarea is never overwritten)
  if (params.explanation) {
    const explicitExpInput = scopedTextbox(
      modal,
      bilingualRegex('explanation|solution|hint', '解析|解释|说明|答案解析'),
    );
    const fallbackExpInput = modal
      .locator('input[type="text"], textarea')
      .filter({
        hasNot: modal.locator(
          '[placeholder*="question" i], [placeholder*="option" i], [placeholder*="问题"], [placeholder*="选项"]',
        ),
      })
      .last();
    const expInput =
      (await explicitExpInput.count()) > 0 &&
      (await explicitExpInput.first().isVisible())
        ? explicitExpInput.first()
        : fallbackExpInput;
    await expect(expInput).toBeVisible();
    await expInput.fill(params.explanation);
  }
}

async function triggerPollBubbleAction(
  page: Page,
  pollBubble: Locator,
  action: BilingualActionKey | RegExp,
): Promise<void> {
  const inlineBtn = scopedButton(pollBubble, action).first();
  if ((await inlineBtn.count()) > 0 && (await inlineBtn.isVisible())) {
    await inlineBtn.click();
  } else {
    const moreInBubble = pollBubble
      .locator(
        'button[aria-label*="more" i], button[aria-label*="更多" i], [data-testid*="more" i]',
      )
      .first();
    if ((await moreInBubble.count()) > 0 && (await moreInBubble.isVisible())) {
      await moreInBubble.click();
      const menu = page
        .locator('[role="menu"], [data-testid="context-menu"]')
        .first();
      await expect(menu).toBeVisible();
      await scopedMenuItem(menu, action).first().click();
    } else {
      await openContextMenuAndClick(page, pollBubble, action);
    }
  }

  const confirmDialog = page
    .locator('[role="alertdialog"]')
    .filter({ hasNot: page.locator(DOM.chatList) })
    .first();
  if (await confirmDialog.isVisible()) {
    await scopedButton(
      confirmDialog,
      bilingualRegex('stop|close|confirm|ok', '结束|关闭|确认|确定'),
    )
      .last()
      .click();
  }
}

test.describe(
  'F13 — Interactive Polls, Quiz Mode, Collaborative Todo Checklists & Invoices',
  () => {
    test('F13-01: #modal-create-poll creates a visible-voter regular poll and updates live percentage bars on voting', async ({
      authPage,
    }) => {
      await selectGroupOrWritableChat(authPage);

      const modal = await openCreatePollModal(authPage);
      const question = 'F13 Architecture Vote — 架构投票?';

      await fillPollModalFields(modal, {
        question,
        options: ['Hexagonal TypeScript', 'Monolith Legacy', 'Raw Static'],
        anonymous: false,
      });

      const submitBtn = scopedButton(
        modal,
        bilingualRegex('create|send|submit|done', '创建|发送|发布|完成'),
      ).last();
      await expect(submitBtn).toBeVisible();
      await submitBtn.click();
      await expect(modal).toBeHidden();

      const pollBubble = authPage
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: 'F13 Architecture Vote' })
        .last();
      await expect(pollBubble).toBeVisible();
      await expect(pollBubble).toContainText('Hexagonal TypeScript');
      await expect(pollBubble).toContainText('Monolith Legacy');
      await expect(pollBubble).toContainText('Raw Static');

      // Vote for "Hexagonal TypeScript"
      const choiceTarget = pollBubble
        .locator('button, [role="radio"], [role="checkbox"], label, [data-option-index]')
        .filter({ hasText: 'Hexagonal TypeScript' })
        .first();
      if ((await choiceTarget.count()) > 0 && (await choiceTarget.isVisible())) {
        await choiceTarget.click();
      } else {
        await pollBubble.getByText('Hexagonal TypeScript').first().click();
      }

      // Live percentage & vote count post-conditions
      await expect(pollBubble).toContainText(/100\s*%/);
      await expect(pollBubble).toContainText(/0\s*%/);
      await expect(pollBubble).toContainText(/1\s*(?:vote|voter|票|人)/i);

      // Verify percentage bar ARIA / width reflection (polling so CSS width transitions settle)
      await expect
        .poll(
          async () =>
            pollBubble.evaluate((el) => {
              const progressAria = el.querySelector(
                '[role="progressbar"][aria-valuenow="100"], [data-percent="100"]',
              );
              if (progressAria) return true;

              const allBars = Array.from(
                el.querySelectorAll(
                  '[role="progressbar"], [class*="progress" i], [class*="bar" i], [style*="width"]',
                ),
              ).filter(
                (node): node is HTMLElement => node instanceof HTMLElement,
              );

              if (allBars.length >= 2) {
                const widths = allBars.map(
                  (b) => b.getBoundingClientRect().width,
                );
                return Math.max(...widths) > Math.min(...widths);
              }
              return false;
            }),
          {
            message:
              'Expected voted poll option percentage bar to render wider than unvoted options',
            timeout: 4_000,
          },
        )
        .toBe(true);
    });

    test('F13-02: Retract Vote resets poll selection, Poll Results drawer inspects voters, and Close Poll locks final results', async ({
      authPage,
    }) => {
      await selectGroupOrWritableChat(authPage);

      const modal = await openCreatePollModal(authPage);
      const question = 'F13 Lifecycle Poll';

      await fillPollModalFields(modal, {
        question,
        options: ['Option Alpha', 'Option Beta'],
        anonymous: false,
      });

      await scopedButton(
        modal,
        bilingualRegex('create|send|submit|done', '创建|发送|发布|完成'),
      )
        .last()
        .click();
      await expect(modal).toBeHidden();

      const pollBubble = authPage
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: question })
        .last();
      await expect(pollBubble).toBeVisible();

      // 1. Vote for Option Alpha
      await pollBubble.getByText('Option Alpha').first().click();
      await expect(pollBubble).toContainText(/100\s*%/);

      // 2. Retract Vote -> resets poll selection
      await triggerPollBubbleAction(authPage, pollBubble, 'retractVote');
      await expect
        .poll(
          async () => {
            const txt = await pollBubble.innerText();
            return (
              /0\s*(?:votes|voters|票|人)|no votes|暂无投票/i.test(txt) ||
              !/100\s*%/.test(txt)
            );
          },
          { timeout: 6_000 },
        )
        .toBe(true);

      // 3. Re-vote for Option Beta and inspect Poll Results drawer/modal
      await pollBubble.getByText('Option Beta').first().click();
      await expect(pollBubble).toContainText(/100\s*%/);

      const resultsPattern = bilingualRegex(
        'view\\s*results|poll\\s*results|results|voters',
        '查看结果|投票结果|结果|投票详情|详情',
      );
      await triggerPollBubbleAction(authPage, pollBubble, resultsPattern);

      const resultsSurface = authPage
        .locator(
          '[data-testid*="poll-results" i], [id*="poll-results" i], [role="dialog"]',
        )
        .filter({ hasNot: authPage.locator(DOM.chatList) })
        .or(authPage.locator(DOM.rightColumn))
        .filter({ hasText: 'Option Beta' })
        .first();

      await expect(resultsSurface).toBeVisible();
      await expect(resultsSurface).toContainText('Option Beta');

      // Close results modal if it is a dialog covering the stage
      const dialogResults = authPage
        .locator('[role="dialog"]')
        .filter({ hasNot: authPage.locator(DOM.chatList) })
        .filter({ hasText: 'Option Beta' })
        .first();
      if ((await dialogResults.count()) > 0 && (await dialogResults.isVisible())) {
        await authPage.keyboard.press('Escape');
      }

      // 4. Close / Stop Poll -> final results locked
      await triggerPollBubbleAction(authPage, pollBubble, 'stopPoll');

      // Confirm stop-poll dialog if shown after context action
      const stopConfirmDialog = authPage
        .locator('[role="dialog"], [role="alertdialog"]')
        .filter({ hasNot: authPage.locator(DOM.chatList) })
        .first();
      if (await stopConfirmDialog.isVisible()) {
        const confirmStopBtn = scopedButton(
          stopConfirmDialog,
          bilingualRegex('stop|close|confirm|ok', '结束|关闭|确认|确定'),
        ).last();
        if (
          (await confirmStopBtn.count()) > 0 &&
          (await confirmStopBtn.isVisible())
        ) {
          await confirmStopBtn.click();
        }
      }

      await expect(pollBubble).toContainText(
        /final\s*results|closed|ended|poll\s*closed|最终结果|已结束|已关闭/i,
      );
    });

    test('F13-03: #modal-create-poll Quiz mode single-answer selection displays explanation and correctness feedback', async ({
      authPage,
    }) => {
      await selectGroupOrWritableChat(authPage);

      const modal = await openCreatePollModal(authPage);
      const quizQuestion = 'Which cipher protects Secret Chats E2EE?';
      const explanationMarker = 'QUIZ_EXPLANATION_HKDF_AES256GCM';

      await fillPollModalFields(modal, {
        question: quizQuestion,
        options: ['ROT13 Plaintext', 'AES-256-GCM + ECDH'],
        quizMode: true,
        correctIndex: 1,
        explanation: explanationMarker,
      });

      await scopedButton(
        modal,
        bilingualRegex('create|send|submit|done', '创建|发送|发布|完成'),
      )
        .last()
        .click();
      await expect(modal).toBeHidden();

      const quizBubble = authPage
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: quizQuestion })
        .last();
      await expect(quizBubble).toBeVisible();

      // Click wrong option to trigger single-choice Quiz evaluation & explanation
      await quizBubble.getByText('ROT13 Plaintext').first().click();

      // If explanation is toggled via solution bulb icon inside quizBubble, click it if explanation isn't shown yet
      if (!(await authPage.getByText(explanationMarker).first().isVisible())) {
        const bulbBtn = scopedButton(
          quizBubble,
          bilingualRegex('explanation|solution|hint|💡', '解析|说明|提示'),
        ).first();
        if ((await bulbBtn.count()) > 0 && (await bulbBtn.isVisible())) {
          await bulbBtn.click();
        }
      }

      await expect(authPage.getByText(explanationMarker).first()).toBeVisible();
      await expect(quizBubble).toContainText(/100\s*%|0\s*%|✓|✗|correct|正确|错误/i);
    });

    test('F13-04: #modal-create-todo creates collaborative Todo checklist and updates item check/uncheck state live', async ({
      authPage,
    }) => {
      await selectGroupOrWritableChat(authPage);

      const todoModal = authPage.locator(DOM.modalCreateTodo);
      const picked = await openAttachMenuAndPick(authPage, 'todo');
      if (!picked && !(await todoModal.isVisible())) {
        const directTodoBtn = scopedButton(
          authPage.locator(DOM.middleColumn),
          'todo',
        ).first();
        if (
          (await directTodoBtn.count()) > 0 &&
          (await directTodoBtn.isVisible())
        ) {
          await directTodoBtn.click();
        }
      }

      await expect(todoModal).toBeVisible();

      const checklistTitle = 'M3 Ship Gate Checklist';
      const itemOne = 'Pass TypeScript strict check';
      const itemTwo = 'Pass Chromium fail-closed probe';

      const titleInput = await pickVisibleFirst(
        scopedTextbox(
          todoModal,
          bilingualRegex('title|list|name|heading', '标题|名称|清单'),
        ),
        todoModal.locator('input[type="text"], textarea'),
      );
      await expect(titleInput).toBeVisible();
      await titleInput.fill(checklistTitle);

      // Populate both todo items across either multi-input rows or input+Add-button pattern
      const resolveTodoInputs = async (): Promise<Locator> => {
        const explicit = scopedTextbox(
          todoModal,
          bilingualRegex('item|task|step|todo', '待办|事项|条目|任务'),
        );
        if ((await explicit.count()) >= 1) {
          return explicit;
        }
        return todoModal.locator('input[type="text"], textarea');
      };

      let itemInputs = await resolveTodoInputs();
      const firstInputVal =
        (await itemInputs.count()) > 0
          ? await itemInputs.first().inputValue()
          : '';
      const offset = firstInputVal === checklistTitle ? 1 : 0;

      const addItemBtn = scopedButton(
        todoModal,
        bilingualRegex(
          'add.*item|new.*item|add.*task|\\+',
          '添加事项|添加待办|新增|添加',
        ),
      ).first();

      if ((await itemInputs.count()) <= offset) {
        await expect(addItemBtn).toBeVisible();
        await addItemBtn.click();
        itemInputs = await resolveTodoInputs();
      }

      await itemInputs.nth(offset).fill(itemOne);

      if ((await itemInputs.count()) > offset + 1) {
        await itemInputs.nth(offset + 1).fill(itemTwo);
      } else if ((await addItemBtn.count()) > 0 && (await addItemBtn.isVisible())) {
        await addItemBtn.click();
        itemInputs = await resolveTodoInputs();
        if ((await itemInputs.count()) > offset + 1) {
          await itemInputs.nth(offset + 1).fill(itemTwo);
        } else {
          await itemInputs.nth(offset).fill(itemTwo);
          await addItemBtn.click();
        }
      } else {
        await itemInputs.nth(offset).press('Enter');
        itemInputs = await resolveTodoInputs();
        const targetIdx =
          (await itemInputs.count()) > offset + 1 ? offset + 1 : offset;
        await itemInputs.nth(targetIdx).fill(itemTwo);
      }

      const submitTodoBtn = scopedButton(
        todoModal,
        bilingualRegex('create|send|submit|done|save', '创建|发送|发布|完成|保存'),
      ).last();
      await expect(submitTodoBtn).toBeVisible();
      await submitTodoBtn.click();
      await expect(todoModal).toBeHidden();

      const todoBubble = authPage
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: checklistTitle })
        .last();
      await expect(todoBubble).toBeVisible();
      await expect(todoBubble).toContainText(itemOne);
      await expect(todoBubble).toContainText(itemTwo);

      // Locate interactive toggle for itemOne (strictly leaf row / checkbox — never ancestor div containing entire card)
      const namedCheckbox = todoBubble.getByRole('checkbox', {
        name: new RegExp(itemOne, 'i'),
      });
      const leafRowControl = todoBubble
        .locator('label, li, [data-todo-item], [role="listitem"]')
        .filter({ hasText: itemOne })
        .filter({ hasNotText: itemTwo })
        .locator('input[type="checkbox"], [role="checkbox"], button');
      const leafRowLabel = todoBubble
        .locator('label, li, [data-todo-item], [role="listitem"]')
        .filter({ hasText: itemOne })
        .filter({ hasNotText: itemTwo });

      let itemOneCheckbox = todoBubble.getByText(itemOne).first();
      if (
        (await namedCheckbox.count()) > 0 &&
        (await namedCheckbox.first().isVisible())
      ) {
        itemOneCheckbox = namedCheckbox.first();
      } else if (
        (await leafRowControl.count()) > 0 &&
        (await leafRowControl.first().isVisible())
      ) {
        itemOneCheckbox = leafRowControl.first();
      } else if (
        (await leafRowLabel.count()) > 0 &&
        (await leafRowLabel.first().isVisible())
      ) {
        itemOneCheckbox = leafRowLabel.first();
      }

      const readItemOneChecked = async (): Promise<boolean> => {
        return todoBubble.evaluate((el, labelText) => {
          const checkboxes = Array.from(
            el.querySelectorAll('input[type="checkbox"], [role="checkbox"]'),
          );
          if (checkboxes.length > 0) {
            const first = checkboxes[0];
            if (first instanceof HTMLInputElement) return first.checked;
            return first.getAttribute('aria-checked') === 'true';
          }
          const txt = el.textContent ?? '';
          if (/\b1\s*\/\s*2\b|\b50\s*%/i.test(txt)) return true;
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
          let node = walker.nextNode();
          while (node) {
            if (
              node instanceof HTMLElement &&
              (node.textContent ?? '').includes(labelText) &&
              (node.dataset.checked === 'true' ||
                node.getAttribute('aria-checked') === 'true' ||
                window
                  .getComputedStyle(node)
                  .textDecorationLine.includes('line-through'))
            ) {
              return true;
            }
            node = walker.nextNode();
          }
          return false;
        }, itemOne);
      };

      expect(await readItemOneChecked()).toBe(false);

      // Check item 1
      await itemOneCheckbox.click();
      await expect.poll(readItemOneChecked, { timeout: 5_000 }).toBe(true);

      // Uncheck item 1
      await itemOneCheckbox.click();
      await expect.poll(readItemOneChecked, { timeout: 5_000 }).toBe(false);
    });

    test('F13-05: Stars/TON/Stripe Invoice card checkout (#wallet-stars-modal top-up if needed) produces paid receipt confirmation', async ({
      authPage,
    }) => {
      // 1. Ensure #wallet-stars-modal opens genuinely from #menu-item-wallet and has sufficient Stars balance
      const walletModal = authPage.locator(DOM.walletStarsModal);
      await expect(walletModal).toBeHidden();

      await openBurgerMenu(authPage);
      const walletMenuItem = authPage.locator(DOM.menuItemWallet);
      await expect(walletMenuItem).toBeVisible();
      await walletMenuItem.click();

      await expect(walletModal).toBeVisible();

      const topUpBtn = scopedButton(
        walletModal,
        bilingualRegex(
          'top\\s*up|buy\\s*stars|add\\s*stars|recharge|\\+\\s*\\d+',
          '充值|购买星币|获取星币|增加',
        ),
      ).first();
      if ((await topUpBtn.count()) > 0 && (await topUpBtn.isVisible())) {
        await topUpBtn.click();
        const confirmTopUp = scopedButton(
          walletModal,
          bilingualRegex('confirm\\s*pay|complete\\s*purchase', '确认支付|完成购买'),
        ).first();
        if (
          (await confirmTopUp.count()) > 0 &&
          (await confirmTopUp.isVisible())
        ) {
          await confirmTopUp.click();
        }
      }

      await authPage.keyboard.press('Escape');
      if (await walletModal.isVisible()) {
        const closeWalletBtn = scopedButton(walletModal, 'cancel').first();
        if (
          (await closeWalletBtn.count()) > 0 &&
          (await closeWalletBtn.isVisible())
        ) {
          await closeWalletBtn.click();
        }
      }
      await expect(walletModal).toBeHidden();

      // 2. Create an Invoice card via #btn-attach-menu if supported, otherwise locate seeded Invoice card
      await selectGroupOrWritableChat(authPage);
      let invoiceBubble: Locator | null = null;

      const invoicePattern = bilingualRegex(
        'invoice|payment|paid|bill|gift',
        '账单|发票|收款|付费|礼物',
      );
      const openedInvoiceCreator = await openAttachMenuAndPick(
        authPage,
        invoicePattern,
      );

      if (openedInvoiceCreator) {
        const invoiceDialog = authPage
          .locator('[role="dialog"]')
          .filter({ hasNot: authPage.locator(DOM.chatList) })
          .first();
        if (await invoiceDialog.isVisible()) {
          const textboxes = invoiceDialog.locator(
            'input[type="text"], input[type="number"], textarea',
          );
          const tbCount = await textboxes.count();
          if (tbCount >= 1) {
            await textboxes.nth(0).fill('Pro AI Compute Pass');
          }
          if (tbCount >= 2) {
            const secondType = await textboxes.nth(1).getAttribute('type');
            if (secondType === 'number') {
              await textboxes.nth(1).fill('25');
            } else {
              await textboxes.nth(1).fill('1 Month GPU Quota');
            }
          }
          const numInput = invoiceDialog.locator('input[type="number"]').first();
          if ((await numInput.count()) > 0 && (await numInput.isVisible())) {
            await numInput.fill('25');
          }

          await scopedButton(
            invoiceDialog,
            bilingualRegex('create|send|submit|done', '创建|发送|发布|完成'),
          )
            .last()
            .click();
          await expect(invoiceDialog).toBeHidden();

          invoiceBubble = authPage
            .locator(DOM.messageList)
            .locator(DOM.messageBubble)
            .filter({ hasText: 'Pro AI Compute Pass' })
            .last();
        }
      }

      const payButtonPattern = bilingualRegex(
        '\\bpay\\b|checkout|purchase|buy|unlock',
        '支付|付款|购买|结账|解锁',
      );

      if (!invoiceBubble) {
        const rows = authPage.locator(DOM.chatList).locator(DOM.chatRow);
        const totalRows = await rows.count();
        for (let i = 0; i < Math.min(totalRows, 12); i++) {
          await selectChat(authPage, i);
          const candidateBubbles = authPage
            .locator(DOM.messageList)
            .locator(DOM.messageBubble);
          const bCount = await candidateBubbles.count();
          for (let j = bCount - 1; j >= 0; j--) {
            const b = candidateBubbles.nth(j);
            const payBtn = scopedButton(b, payButtonPattern).first();
            if ((await payBtn.count()) > 0 && (await payBtn.isVisible())) {
              invoiceBubble = b;
              break;
            }
          }
          if (invoiceBubble) break;
        }
      }

      expect(invoiceBubble).not.toBeNull();
      await expect(invoiceBubble!).toBeVisible();

      const payBtn = await pickVisibleFirst(
        scopedButton(invoiceBubble!, payButtonPattern),
        invoiceBubble!.locator(
          'button:not([data-testid*="react" i]):not([aria-label*="react" i]):not([aria-label*="回应"])',
        ),
      );
      await expect(payBtn).toBeVisible();

      const bubbles = authPage.locator(DOM.messageList).locator(DOM.messageBubble);
      const bubbleCountBefore = await bubbles.count();
      const invoiceTextBefore = (await invoiceBubble!.innerText()).trim();
      const invoiceAttrBefore = await invoiceBubble!.evaluate(
        (el) =>
          `${el.getAttribute('data-paid') ?? ''}|${el.getAttribute('data-status') ?? ''}`,
      );
      const receiptNodesBefore = await authPage
        .locator('[data-testid*="receipt" i]')
        .count();

      await payBtn.click();

      // Confirm checkout dialog if a modal confirmation step opens
      const checkoutDialog = authPage
        .locator('[role="dialog"]')
        .filter({ hasNot: authPage.locator(DOM.chatList) })
        .or(authPage.locator(DOM.walletStarsModal))
        .first();

      if (await checkoutDialog.isVisible()) {
        const confirmPayBtn = scopedButton(
          checkoutDialog,
          bilingualRegex(
            'pay|confirm|complete|purchase',
            '确认支付|立即支付|支付|付款|确认|完成',
          ),
        ).last();
        if (
          (await confirmPayBtn.count()) > 0 &&
          (await confirmPayBtn.isVisible())
        ) {
          await confirmPayBtn.click();
        }
      }

      // Assert concrete Paid / Receipt state mutation (word-bounded \bpaid\b, stripping unpaid/未支付/待支付)
      const paidReceiptRegex =
        /\breceipt\b|\bpaid\b|payment\s*complete|purchased|收据|已支付|支付成功|已付款|已购买/i;
      const unpaidGuardRegex = /\bunpaid\b|not\s*paid|未支付|待支付|未付款/gi;
      const hasGenuinePaidCopy = (raw: string): boolean => {
        const cleaned = raw.replace(unpaidGuardRegex, ' ');
        return paidReceiptRegex.test(cleaned);
      };

      await expect
        .poll(
          async () => {
            const receiptLoc = authPage.locator('[data-testid*="receipt" i]');
            const receiptCountNow = await receiptLoc.count();
            if (receiptCountNow > receiptNodesBefore) {
              const newestReceipt = receiptLoc.last();
              if (await newestReceipt.isVisible()) {
                return true;
              }
            }

            if (await invoiceBubble!.isVisible()) {
              const invoiceTextAfter = (await invoiceBubble!.innerText()).trim();
              const invoiceAttrAfter = await invoiceBubble!.evaluate(
                (el) =>
                  `${el.getAttribute('data-paid') ?? ''}|${el.getAttribute('data-status') ?? ''}`,
              );
              const bubbleMutated =
                invoiceTextAfter !== invoiceTextBefore ||
                invoiceAttrAfter !== invoiceAttrBefore;
              if (
                bubbleMutated &&
                (hasGenuinePaidCopy(invoiceTextAfter) ||
                  /\b(?:true|paid)\b/i.test(invoiceAttrAfter))
              ) {
                return true;
              }
            }

            const bubbleCountNow = await bubbles.count();
            if (bubbleCountNow > bubbleCountBefore) {
              for (let idx = bubbleCountBefore; idx < bubbleCountNow; idx++) {
                const newBubbleTxt = await bubbles.nth(idx).innerText();
                if (hasGenuinePaidCopy(newBubbleTxt)) {
                  return true;
                }
              }
            }

            const activeDialog = authPage
              .locator('[role="dialog"]')
              .filter({ hasNot: authPage.locator(DOM.chatList) })
              .first();
            if (await activeDialog.isVisible()) {
              return hasGenuinePaidCopy(await activeDialog.innerText());
            }

            return false;
          },
          {
            message:
              'Expected Invoice checkout to mutate invoice card or append a Paid Receipt confirmation',
            timeout: 8_000,
          },
        )
        .toBe(true);
    });
  },
);
