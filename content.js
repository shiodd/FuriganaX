// ============================================================
// X 振り仮名 - Content Script
// 在 X.com 推文中注入"振仮名"按钮，处理标注逻辑
// ============================================================

const BUTTON_LABEL = '仮';
const ACTIVE_CLASS = 'jpfurigana-active';
const EXTENSION_ID = chrome.runtime.id;
const INJECT_SRC = `chrome-extension://${EXTENSION_ID}/inject.js`;

// ---- 注入 kuromoji 分析脚本到页面上下文 ----
function injectAnalyzer() {
  if (document.querySelector('script[data-jpfurigana]')) return;

  const script = document.createElement('script');
  script.src = INJECT_SRC;
  script.dataset.jpfurigana = '1';
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

// ---- 判断是否为日文文本（含汉字/假名） ----
function isJapaneseText(text) {
  return /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9faf\u3400-\u4dbf]/.test(text);
}

// ---- 获取推文文本内容 ----
function getTweetText(tweetElement) {
  // 优先选择 data-testid="tweetText" 元素
  const textEl = tweetElement.querySelector('[data-testid="tweetText"]');
  if (!textEl) return '';

  // 遍历文本节点，排除已标注的 ruby 内容
  const parts = [];
  const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while ((node = walker.nextNode())) {
    // 跳过已标注的 ruby 内部文本
    if (node.parentElement?.closest?.('ruby')) continue;
    parts.push(node.textContent);
  }

  const text = parts.join('').trim();
  return text;
}

// ---- 添加 ruby 标注到推文中（保留原有 HTML 结构：链接、emoji 等） ----
function applyFurigana(tweetElement, words) {
  const textEl = tweetElement.querySelector('[data-testid="tweetText"]');
  if (!textEl) return;

  // 清除已有标注
  clearFurigana(tweetElement);

  // 收集所有文本节点（跳过 ruby 内部的文本、空节点）
  const textNodes = [];
  const nodeRanges = []; // { node, start: 在合并文本中的起始位置 }
  let combinedOffset = 0;

  const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest?.('ruby')) continue;
    if (node.textContent.length === 0) continue;
    textNodes.push(node);
    nodeRanges.push({ node, start: combinedOffset, end: combinedOffset + node.textContent.length });
    combinedOffset += node.textContent.length;
  }

  if (textNodes.length === 0) return;

  // 将 words 中的待标注词定位到对应的文本节点
  // replacements: Map<nodeIndex, [{start, length, kanji, kana}]>
  const replacements = new Map();
  let pos = 0;

  for (const word of words) {
    if (word.kanji && word.kana) {
      const wordLen = word.kanji.length;
      for (let i = 0; i < nodeRanges.length; i++) {
        const r = nodeRanges[i];
        if (pos >= r.end || pos + wordLen <= r.start) continue;
        // 词与该文本节点有交集
        const localStart = Math.max(pos, r.start) - r.start;
        const localEnd = Math.min(pos + wordLen, r.end) - r.start;
        const kanjiSlice = word.kanji.slice(Math.max(r.start - pos, 0), Math.max(r.end - pos, 0));
        if (localEnd > localStart) {
          if (!replacements.has(i)) replacements.set(i, []);
          replacements.get(i).push({ start: localStart, length: localEnd - localStart, kanji: kanjiSlice, kana: word.kana });
        }
      }
    }
    pos += (word.text || word.kanji || '').length;
  }

  // 逐个文本节点，从右到左插入 ruby（保证左侧位置不受影响）
  for (const [nodeIdx, reps] of replacements) {
    // 按起始位置从右向左排序
    reps.sort((a, b) => b.start - a.start);
    applyRubyToTextNode(textNodes[nodeIdx], reps);
  }

  textEl.dataset.jpfurigana = '1';
}

// ---- 在单个文本节点中插入 ruby（从右到左处理） ----
function applyRubyToTextNode(textNode, replacements) {
  const parent = textNode.parentNode;

  for (const rep of replacements) {
    // 用 splitText 切分文本节点
    const afterNode = textNode.splitText(rep.start + rep.length); // 右侧部分
    const kanjiNode = textNode.splitText(rep.start);               // 汉字部分
    // textNode 现在只剩左侧文本

    // 用 ruby 替换汉字文本节点
    const ruby = document.createElement('ruby');
    ruby.className = 'jpfurigana-ruby';
    ruby.textContent = rep.kanji;
    const rt = document.createElement('rt');
    rt.className = 'jpfurigana-rt';
    rt.textContent = rep.kana;
    ruby.appendChild(rt);
    parent.replaceChild(ruby, kanjiNode);
  }
}

// ---- 清除标注（保留原有 HTML 结构） ----
function clearFurigana(tweetElement) {
  const textEl = tweetElement.querySelector('[data-testid="tweetText"]');
  if (!textEl) return;

  if (textEl.dataset.jpfurigana !== '1') return;

  // 只移除 ruby 元素，保留链接、emoji 等 HTML 元素
  const rubies = textEl.querySelectorAll('ruby.jpfurigana-ruby');
  // 从后往前处理，避免 NodeList 动态变化
  for (let i = rubies.length - 1; i >= 0; i--) {
    const ruby = rubies[i];
    const rt = ruby.querySelector('rt');
    const kanji = rt ? ruby.textContent.replace(rt.textContent, '') : ruby.textContent;
    ruby.replaceWith(document.createTextNode(kanji));
  }

  delete textEl.dataset.jpfurigana;
}

// ---- 为推文添加按钮 ----
function addButtonToTweet(tweetElement) {
  if (tweetElement.querySelector('.jpfurigana-btn')) return;

  // 定位推文顶部的「更多」按钮(⋯)，我们的按钮放它左边
  const moreBtn = tweetElement.querySelector(
    'button[aria-label="More"], button[data-testid="caret"], button[aria-label*="もっと"]'
  );
  if (!moreBtn) return;

  const btn = document.createElement('button');
  btn.className = 'jpfurigana-btn';
  btn.textContent = BUTTON_LABEL;
  btn.title = '为汉字标注假名读音';

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();

    if (btn.classList.contains(ACTIVE_CLASS)) {
      // 切换关闭
      clearFurigana(tweetElement);
      btn.classList.remove(ACTIVE_CLASS);
      return;
    }

    const text = getTweetText(tweetElement);
    if (!text || !isJapaneseText(text)) return;

    btn.disabled = true;

    // 发送分析请求（通过 postMessage 到 inject.js）
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('分析超时')), 15000);

        const handler = (event) => {
          if (event.data?.type === 'JP_ANALYSIS_RESULT' && event.data?.requestId === requestId) {
            window.removeEventListener('message', handler);
            clearTimeout(timeout);
            resolve(event.data.words);
          }
        };
        window.addEventListener('message', handler);

        // 发送分析请求
        window.postMessage({
          type: 'JP_ANALYZE_TEXT',
          requestId,
          text
        }, window.location.origin);
      });

      if (result && result.length > 0) {
        applyFurigana(tweetElement, result);
        btn.classList.add(ACTIVE_CLASS);
      }
    } catch (err) {
      console.error('[JPFurigana] Analysis error:', err);
    } finally {
      btn.disabled = false;
    }
  });

  // 插入到「更多」按钮之前（同一行，靠右）
  moreBtn.parentElement.insertBefore(btn, moreBtn);
}

// ---- MutationObserver 监听新推文 ----
function observeTweets() {
  let pendingNodes = [];
  let tickScheduled = false;

  const processPending = () => {
    tickScheduled = false;
    const nodes = pendingNodes;
    pendingNodes = [];

    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      // 当前节点本身是推文
      if (node.matches?.('[data-testid="tweet"]')) {
        addButtonToTweet(node);
      }

      // 查找子推文
      const tweets = node.querySelectorAll?.('[data-testid="tweet"]');
      if (tweets && tweets.length > 0) {
        tweets.forEach(addButtonToTweet);
      }
    }
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        pendingNodes.push(node);
      }
    }

    // 用 requestAnimationFrame 批量处理，避免频繁触发
    if (!tickScheduled) {
      tickScheduled = true;
      requestAnimationFrame(processPending);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// ---- 扫描已有推文（只处理没有按钮的推文） ----
function scanExistingTweets() {
  document.querySelectorAll('[data-testid="tweet"]:not(:has(.jpfurigana-btn))').forEach(addButtonToTweet);
}

// ---- 持续兜底扫描（X.com 是 React SPA，首次加载时推文可能很晚才渲染） ----
function startPeriodicScan() {
  // X.com 首次访问需登录/鉴权，推文可能 10+ 秒后才出现
  // 用渐进间隔持续兜底，确保不会遗漏
  const schedule = [1000, 3000, 5000, 10000, 20000, 30000];
  schedule.forEach(delay => {
    setTimeout(() => scanExistingTweets(), delay);
  });

  // 之后每 60 秒兜底一次（捕获极端情况）
  const intervalId = setInterval(() => scanExistingTweets(), 60000);

  // 页面隐藏之后再显示时，可能错过了一些推文渲染，重新扫描
  const onVisibility = () => {
    if (!document.hidden) {
      scanExistingTweets();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // SPA 导航检测：X 使用 history.pushState，通过定时轮询 URL 变化来兜底
  let lastUrl = location.href;
  const urlCheckId = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // URL 变化后延迟一下等 React 渲染
      [500, 2000].forEach(d => setTimeout(() => scanExistingTweets(), d));
    }
  }, 2000);

  return () => {
    clearInterval(intervalId);
    clearInterval(urlCheckId);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

// ---- 初始化 ----
function init() {
  injectAnalyzer();

  // MutationObserver 立即启动，捕获动态推文
  observeTweets();

  // 持续兜底扫描
  startPeriodicScan();
}

init();
